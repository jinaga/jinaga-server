import {
    computeTupleSubsetHash,
    FactManager,
    FactReference,
    FeedObject,
    FeedResponse,
    invertSpecification,
    ProjectedResult,
    Specification,
    SpecificationListener,
    Trace
} from "jinaga";
import { FeedResult } from "../authorization/authorization-keystore";
import { Stream } from "../http/stream";

/**
 * A function that queries the feed for the next page of tuples, starting
 * from the supplied bookmark. Returns a {@link FeedResult} so the session
 * can keep the stream alive when distribution is denied at query time.
 */
export type FeedQuery = (bookmark: string) => Promise<FeedResult>;

export interface FeedStreamSessionConfig {
    /** Maximum number of pages to stream before giving up (infinite-loop guard). */
    maxInitialPages: number;
    /** Maximum number of references the waitlist may hold before the stream is dropped. */
    waitlistCap: number;
    /** Insert a small delay every N pages to avoid overwhelming the database. */
    pageDelayEvery: number;
    /** Length of the delay inserted by {@link pageDelayEvery}, in milliseconds. */
    pageDelayMs: number;
}

export const defaultFeedStreamSessionConfig: FeedStreamSessionConfig = {
    maxInitialPages: 1000,
    waitlistCap: 50000,
    pageDelayEvery: 10,
    pageDelayMs: 10
};

interface FeedStreamSessionTelemetry {
    initialPages: number;
    referencesStreamed: number;
    cycles: number;
    syncFrames: number;
    waitlistRestarts: number;
    waitlistHighWater: number;
}

function referenceKey(reference: FactReference): string {
    return `${reference.type}:${reference.hash}`;
}

function dedupeReferences(references: FactReference[]): FactReference[] {
    return references.filter((value, index, self) =>
        self.findIndex(other => other.hash === value.hash && other.type === value.type) === index);
}

/**
 * Per-connection proxy for a streaming feed subscription.
 *
 * The session funnels every fetch and stream operation through a single
 * "query cycle" driven by the current bookmark. Inverse observers never
 * fetch or stream directly; they only enqueue fact references onto a
 * waitlist and wake the cycle. This serialization removes the race between
 * listener callbacks and bookmark mutation, guarantees tuple completeness,
 * and ensures no update is lost when facts arrive between pages.
 *
 * See docs/design/feeds-persistent-proxy-plan.md for the full design.
 */
export class FeedStreamSession {
    private bookmark: string;
    private readonly config: FeedStreamSessionConfig;

    // Waitlist of fact references surfaced by inverse observers, keyed by
    // "{type}:{hash}" so duplicates collapse. A reference stays on the
    // waitlist until the tuple that contains it is streamed, preserving
    // tuple completeness.
    private readonly waitlist = new Map<string, FactReference>();

    // Single-cycle execution guard. Only one runCycle() executes at a time;
    // wake-ups that arrive while a cycle runs set needsCycle so the loop
    // re-evaluates before returning.
    private activeCycle = false;
    private needsCycle = false;
    private shuttingDown = false;

    private listeners: SpecificationListener[] = [];
    private readonly telemetry: FeedStreamSessionTelemetry = {
        initialPages: 0,
        referencesStreamed: 0,
        cycles: 0,
        syncFrames: 0,
        waitlistRestarts: 0,
        waitlistHighWater: 0
    };

    constructor(
        private readonly query: FeedQuery,
        private readonly factManager: FactManager,
        private readonly feedDefinition: FeedObject,
        private readonly startReferences: FactReference[],
        private readonly givenHash: string,
        private readonly stream: Stream<FeedResponse>,
        initialBookmark: string,
        private readonly connectionId: string = Math.random().toString(36).substring(2, 10),
        config: Partial<FeedStreamSessionConfig> = {}
    ) {
        this.bookmark = initialBookmark;
        this.config = { ...defaultFeedStreamSessionConfig, ...config };
    }

    /** Current number of references on the waitlist (observability/testing). */
    get waitlistSize(): number {
        return this.waitlist.size;
    }

    /**
     * Register inverse and anchor observers, then kick off the initial
     * paginated backfill. Resolves once the observers are registered; the
     * cycle continues to run asynchronously, feeding the stream.
     */
    start(): void {
        this.registerInverseListeners();
        this.registerAnchorListeners();
        // Kick off the initial backfill. Errors are isolated so a failed
        // cycle never rejects the caller's setup path.
        this.wake();
    }

    /**
     * Tear down all observers and prevent any further cycles. Idempotent.
     */
    dispose(): void {
        if (this.shuttingDown) {
            return;
        }
        this.shuttingDown = true;
        for (const listener of this.listeners) {
            try {
                this.factManager.removeSpecificationListener(listener);
            } catch (error) {
                Trace.error(error);
            }
        }
        this.listeners = [];
        Trace.metric(`Feed stream session ${this.connectionId} closed`, {
            initialPages: this.telemetry.initialPages,
            referencesStreamed: this.telemetry.referencesStreamed,
            cycles: this.telemetry.cycles,
            syncFrames: this.telemetry.syncFrames,
            waitlistRestarts: this.telemetry.waitlistRestarts,
            waitlistHighWater: this.telemetry.waitlistHighWater
        });
    }

    /**
     * Add fact references to the waitlist and wake the cycle. Called by the
     * inverse observers; never fetches or streams directly.
     */
    onInverseMatch(references: FactReference[]): void {
        if (this.shuttingDown) {
            return;
        }
        for (const reference of references) {
            this.waitlist.set(referenceKey(reference), reference);
        }
        if (this.waitlist.size > this.telemetry.waitlistHighWater) {
            this.telemetry.waitlistHighWater = this.waitlist.size;
        }
        if (this.waitlist.size > this.config.waitlistCap) {
            Trace.warn(`Feed stream session ${this.connectionId} waitlist exceeded cap ` +
                `(${this.waitlist.size} > ${this.config.waitlistCap}); closing stream.`);
            this.dispose();
            this.stream.close();
            return;
        }
        this.wake();
    }

    /**
     * Start a cycle if one is not already running. If a cycle is active,
     * mark that another pass is needed once it completes.
     */
    private wake(): void {
        if (this.shuttingDown) {
            return;
        }
        if (this.activeCycle) {
            this.needsCycle = true;
            return;
        }
        // Run the cycle without awaiting; isolate failures.
        void this.runCycle().catch(error => Trace.error(error));
    }

    /**
     * The single serialized query cycle. Pages through the feed until both
     * the query returns no tuples and the waitlist is empty, then emits a
     * SYNC frame. Guarded by activeCycle so no two cycles run concurrently.
     */
    private async runCycle(): Promise<void> {
        if (this.activeCycle) {
            this.needsCycle = true;
            return;
        }
        this.activeCycle = true;
        this.telemetry.cycles++;
        try {
            let pagesThisCycle = 0;
            let keepGoing = true;
            while (keepGoing && !this.shuttingDown) {
                this.needsCycle = false;

                const result = await this.query(this.bookmark);
                if (this.shuttingDown) {
                    break;
                }
                if (result.type === "denied") {
                    // Distribution denied at query time. Keep the stream
                    // alive (an authorizing fact may arrive later and wake a
                    // new cycle) but stop the loop without emitting SYNC,
                    // since we are not actually caught up.
                    Trace.info(`Feed stream session ${this.connectionId} query denied: ${result.reason}`);
                    break;
                }

                const feed = result.feed;
                if (feed.tuples.length > 0) {
                    const references = dedupeReferences(feed.tuples.flatMap(t => t.facts));
                    this.streamPage(references, feed.bookmark);
                    this.removeFromWaitlist(references);
                    pagesThisCycle++;
                    this.telemetry.initialPages++;

                    if (feed.bookmark === this.bookmark) {
                        // The store returned results but the bookmark did not
                        // advance, meaning it cannot paginate further (e.g.
                        // MemoryStore returns the full result set on every
                        // call). Everything available has been delivered, so
                        // treat this as caught-up: drop any waitlist entries
                        // that the full page did not satisfy and emit SYNC.
                        // Re-querying with the same bookmark would loop
                        // forever re-delivering identical tuples.
                        this.waitlist.clear();
                        this.streamSync();
                        keepGoing = false;
                    }
                    else {
                        this.bookmark = feed.bookmark;
                        if (pagesThisCycle >= this.config.maxInitialPages) {
                            Trace.warn(`Feed stream session ${this.connectionId} hit max page limit ` +
                                `(${this.config.maxInitialPages}); ending cycle.`);
                            break;
                        }
                        if (this.config.pageDelayEvery > 0 &&
                            pagesThisCycle % this.config.pageDelayEvery === 0) {
                            await this.delay(this.config.pageDelayMs);
                        }
                        // Continue paging.
                    }
                }
                else {
                    // No tuples this query.
                    if (this.waitlist.size === 0) {
                        this.streamSync();
                        keepGoing = false;
                    }
                    else if (this.needsCycle) {
                        // A wake arrived during this query; re-run so the
                        // just-arrived facts get a chance to produce tuples.
                        this.telemetry.waitlistRestarts++;
                    }
                    else {
                        // The waitlist holds references whose tuples are not
                        // completable at the current bookmark (e.g. a missing
                        // predecessor). They cannot produce a tuple now, so
                        // drop them to avoid spinning and emit SYNC. A later
                        // trigger will re-add them once they are completable.
                        this.waitlist.clear();
                        this.streamSync();
                        keepGoing = false;
                    }
                }
            }
        } finally {
            this.activeCycle = false;
            // A wake that arrived as the loop exited must start a fresh
            // cycle, since this one already cleared activeCycle.
            if (this.needsCycle && !this.shuttingDown) {
                this.needsCycle = false;
                this.wake();
            }
        }
    }

    private streamPage(references: FactReference[], bookmark: string): void {
        const response: FeedResponse = { references, bookmark };
        this.telemetry.referencesStreamed += references.length;
        this.stream.feed(response);
    }

    private streamSync(): void {
        const response: FeedResponse = { references: [], bookmark: this.bookmark };
        this.telemetry.syncFrames++;
        this.stream.feed(response);
    }

    private removeFromWaitlist(references: FactReference[]): void {
        for (const reference of references) {
            this.waitlist.delete(referenceKey(reference));
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private registerInverseListeners(): void {
        const inverses = invertSpecification(this.feedDefinition.feed);
        for (const inverse of inverses) {
            const listener = this.factManager.addSpecificationListener(
                inverse.inverseSpecification,
                async (results: ProjectedResult[]) => {
                    if (this.shuttingDown) {
                        return;
                    }
                    // Only enqueue results whose given subset matches this
                    // subscription's given.
                    const matching = results.filter(pr =>
                        this.givenHash === computeTupleSubsetHash(pr.tuple, inverse.givenSubset));
                    if (matching.length === 0) {
                        return;
                    }
                    const references = dedupeReferences(
                        matching.flatMap(pr => Object.values(pr.tuple)));
                    this.onInverseMatch(references);
                });
            this.listeners.push(listener);
        }
    }

    private registerAnchorListeners(): void {
        // Anchor listeners (jinaga.js#129): the inverse-listener path only
        // fires when a descendant of the given arrives. If the given fact
        // itself isn't yet in the store when the client subscribes, no
        // inverse can deliver results until the given is recorded. Register
        // a listener per unique anchor that wakes the cycle the moment a
        // saved fact matches the anchor's (type, hash). The anchor itself is
        // not added to the waitlist; the query will surface its descendants.
        const uniqueAnchors = this.startReferences.filter((s, i, arr) =>
            arr.findIndex(other => other.type === s.type && other.hash === s.hash) === i);
        for (const anchor of uniqueAnchors) {
            const anchorSpec: Specification = {
                given: [{ label: { name: "x", type: anchor.type }, conditions: [] }],
                matches: [],
                projection: { type: "fact", label: "x" }
            };
            const listener = this.factManager.addSpecificationListener(anchorSpec, async (results: ProjectedResult[]) => {
                if (this.shuttingDown) {
                    return;
                }
                const matched = results.some(pr => {
                    const ref = pr.tuple && (pr.tuple as any).x;
                    return ref && ref.type === anchor.type && ref.hash === anchor.hash;
                });
                if (matched) {
                    this.wake();
                }
            });
            this.listeners.push(listener);
        }
    }
}
