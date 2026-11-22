import { Trace } from "jinaga";

import { compareBookmarkPositions, parseBookmarkPositions } from "../util/bookmark";
import { FeedKeys } from "./feed-identity";

/**
 * What one feed instance has cost so far.
 *
 * The feed-log series that follows spends storage and write work to save
 * read work. Whether an instance earns a log, how much of its start can be
 * trimmed, and when the log can be dropped are all decided from these
 * numbers, so this record carries the measurements and no policy. It
 * accumulates for the life of the process: a reporting window decides what
 * to emit, never what to keep.
 */
export interface FeedUsage extends FeedKeys {
    /** Reads served for this instance, on the polling and streaming paths alike. */
    reads: number;
    /** Milliseconds spent in the feed query across those reads. */
    queryMilliseconds: number;
    /** Reads whose bookmark was empty, so the page started at the beginning of the feed. */
    readsFromEmptyBookmark: number;
    /**
     * The lowest non-empty bookmark any read started from, in the order the
     * store pages a feed. Null until a read arrives with a bookmark that
     * names a position; a bookmark the store could not page from has none.
     */
    earliestBookmark: string | null;
    /** Streaming sessions open on this instance right now. */
    openStreamingSessions: number;
    /** When the last read was served, in milliseconds since the epoch. */
    lastReadAt: number | null;
    /** Reads served since the last reporting window closed. */
    readsInWindow: number;
}

/** How often usage is reported, in milliseconds. */
export const feedUsageWindowMilliseconds = 10000;

/**
 * Accounting for feed reads, per feed instance, and for inverse matches,
 * per feed shape.
 *
 * Reads arrive from the polling handler and from every streaming session's
 * query cycle. Inverse matches arrive from the specification listeners a
 * streaming session registers, which is where the number of rows a saved
 * fact produced for a shape is known.
 */
export class FeedAccounting {
    private readonly usageByInstance = new Map<string, FeedUsage>();
    private readonly inverseMatchesByShape = new Map<string, number>();

    /** Account for one feed read, however long it took and wherever it came from. */
    recordRead(keys: FeedKeys, bookmark: string, queryMilliseconds: number): void {
        const usage = this.usageFor(keys);
        usage.reads++;
        usage.readsInWindow++;
        usage.queryMilliseconds += queryMilliseconds;
        usage.lastReadAt = Date.now();
        if (!bookmark) {
            usage.readsFromEmptyBookmark++;
        }
        else {
            usage.earliestBookmark = earlierBookmark(usage.earliestBookmark, bookmark);
        }
    }

    /** A streaming session has opened on this instance. */
    openStreamingSession(keys: FeedKeys): void {
        this.usageFor(keys).openStreamingSessions++;
    }

    /** A streaming session has closed on this instance. */
    closeStreamingSession(keys: FeedKeys): void {
        const usage = this.usageFor(keys);
        if (usage.openStreamingSessions > 0) {
            usage.openStreamingSessions--;
        }
    }

    /**
     * Account for the rows one of a shape's inverses produced. The inverse
     * listeners are registered per streaming session, so a saved fact that
     * matches is counted once per session it reaches: this is the number of
     * matches delivered for the shape, not the number of facts that matched
     * it.
     */
    recordInverseMatches(shapeKey: string, matches: number): void {
        this.inverseMatchesByShape.set(shapeKey, this.inverseMatches(shapeKey) + matches);
    }

    /** What is known about one instance, or undefined if none was ever read. */
    usage(instanceKey: string): FeedUsage | undefined {
        return this.usageByInstance.get(instanceKey);
    }

    /** Inverse matches delivered for one shape. */
    inverseMatches(shapeKey: string): number {
        return this.inverseMatchesByShape.get(shapeKey) ?? 0;
    }

    /**
     * Close a reporting window: emit one metric for each instance read
     * during it, then start the next window. An instance that was not read
     * emits nothing, so a quiet window is silent and the output rate
     * follows the number of live instances rather than the read rate.
     *
     * The keys ride in the message because a tracer's measurements are
     * numbers. The totals are the accumulated ones, so a reader sees the
     * instance's whole cost and not only this window's slice of it.
     */
    report(): void {
        for (const usage of this.usageByInstance.values()) {
            if (usage.readsInWindow === 0) {
                continue;
            }
            Trace.metric(`Feed usage ${usage.shapeKey} ${usage.instanceKey}`, {
                readsInWindow: usage.readsInWindow,
                reads: usage.reads,
                queryMilliseconds: usage.queryMilliseconds,
                readsFromEmptyBookmark: usage.readsFromEmptyBookmark,
                openStreamingSessions: usage.openStreamingSessions,
                inverseMatches: this.inverseMatches(usage.shapeKey)
            });
            usage.readsInWindow = 0;
        }
    }

    private usageFor(keys: FeedKeys): FeedUsage {
        const existing = this.usageByInstance.get(keys.instanceKey);
        if (existing) {
            return existing;
        }
        const usage: FeedUsage = {
            shapeKey: keys.shapeKey,
            instanceKey: keys.instanceKey,
            reads: 0,
            queryMilliseconds: 0,
            readsFromEmptyBookmark: 0,
            earliestBookmark: null,
            openStreamingSessions: 0,
            lastReadAt: null,
            readsInWindow: 0
        };
        this.usageByInstance.set(keys.instanceKey, usage);
        return usage;
    }
}

/**
 * Report feed usage once per window, following the pool-metrics pattern in
 * `tracePool`: the window closes on a timer so that reads which stop in the
 * middle of a window are still reported, and the timer is unreferenced so
 * it does not hold the process open. Returns the call that stops reporting.
 */
export function traceFeedUsage(
    accounting: FeedAccounting,
    windowMilliseconds: number = feedUsageWindowMilliseconds
): () => void {
    const windowTimer = setInterval(() => accounting.report(), windowMilliseconds);
    windowTimer.unref?.();
    return () => clearInterval(windowTimer);
}

/**
 * Whichever of two bookmarks the store would page first. A bookmark it
 * could not page from loses to one it could, and never becomes the
 * earliest on its own.
 */
function earlierBookmark(current: string | null, candidate: string): string | null {
    const candidatePositions = parseBookmarkPositions(candidate);
    if (candidatePositions === null) {
        return current;
    }
    if (current === null) {
        return candidate;
    }
    const currentPositions = parseBookmarkPositions(current);
    if (currentPositions === null) {
        return candidate;
    }
    return compareBookmarkPositions(candidatePositions, currentPositions) < 0 ? candidate : current;
}
