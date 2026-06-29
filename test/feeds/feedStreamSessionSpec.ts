import {
    buildFeeds,
    computeObjectHash,
    FactFeed,
    FactManager,
    FactReference,
    FeedObject,
    FeedResponse,
    ProjectedResult,
    ReferencesByName,
    Specification,
    SpecificationListener,
    SpecificationParser
} from "jinaga";

import { FeedResult } from "../../src/authorization/authorization-keystore";
import { FeedStreamSession } from "../../src/feeds/feed-stream-session";
import { Stream } from "../../src/http/stream";

// Build a real, invertible feed specification so the session can register
// inverse and anchor listeners during start().
function buildFeedDefinition(): { feedDefinition: FeedObject; givenHash: string } {
    const anchorHash = "anchorhash000000000000000000000000000000000000";
    const input =
        `let p: Jinaga.User = #${anchorHash}\n` +
        `(p: Jinaga.User) {\n` +
        `    post: Test.Post [\n` +
        `        post->author: Jinaga.User = p\n` +
        `    ]\n` +
        `} => post`;
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    const declaration = parser.parseDeclaration([]);
    const specification = parser.parseSpecification();
    const start = specification.given.map(g => {
        const declared = declaration.find(d => d.name === g.label.name);
        return declared!.declared.reference;
    });
    const namedStart = specification.given.reduce((map, g, index) => ({
        ...map,
        [g.label.name]: start[index]
    }), {} as ReferencesByName);
    const feed = buildFeeds(specification)[0];
    const feedDefinition: FeedObject = { feed, namedStart };
    const givenHash = computeObjectHash(namedStart);
    return { feedDefinition, givenHash };
}

// A FactManager test double that records listeners and lets tests drive them.
class FakeFactManager {
    public listeners: { specification: Specification; onResult: (results: ProjectedResult[]) => Promise<void> }[] = [];
    public removed: SpecificationListener[] = [];

    addSpecificationListener(
        specification: Specification,
        onResult: (results: ProjectedResult[]) => Promise<void>
    ): SpecificationListener {
        const listener = { specification, onResult } as unknown as SpecificationListener;
        this.listeners.push({ specification, onResult });
        return listener;
    }

    removeSpecificationListener(listener: SpecificationListener): void {
        this.removed.push(listener);
    }
}

function ref(type: string, hash: string): FactReference {
    return { type, hash };
}

function tuple(...facts: FactReference[]): { facts: FactReference[]; bookmark: string } {
    return { facts, bookmark: "" };
}

function page(bookmark: string, tuples: { facts: FactReference[]; bookmark: string }[]): FeedResult {
    const feed: FactFeed = { tuples, bookmark };
    return { type: "success", feed };
}

function emptyPage(bookmark: string): FeedResult {
    return page(bookmark, []);
}

function makeSession(
    query: (bookmark: string) => Promise<FeedResult>,
    options: {
        initialBookmark?: string;
        config?: ConstructorParameters<typeof FeedStreamSession>[8];
        stream?: Stream<FeedResponse>;
        factManager?: FakeFactManager;
    } = {}
): { session: FeedStreamSession; stream: Stream<FeedResponse>; received: FeedResponse[]; factManager: FakeFactManager } {
    const { feedDefinition, givenHash } = buildFeedDefinition();
    const start = feedDefinition.feed.given.map(g => feedDefinition.namedStart[g.label.name]);
    const stream = options.stream ?? new Stream<FeedResponse>();
    const received: FeedResponse[] = [];
    stream.next(r => received.push(r));
    const factManager = options.factManager ?? new FakeFactManager();
    const session = new FeedStreamSession(
        query,
        factManager as unknown as FactManager,
        feedDefinition,
        start,
        givenHash,
        stream,
        options.initialBookmark ?? "",
        "test-conn",
        options.config ?? {}
    );
    return { session, stream, received, factManager };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

describe("FeedStreamSession", () => {
    it("backfills to exhaustion then emits a SYNC frame", async () => {
        const A = ref("Test.Post", "a");
        const B = ref("Test.Post", "b");
        const C = ref("Test.Post", "c");
        const responses = [
            page("bm1", [tuple(A), tuple(B)]),
            page("bm2", [tuple(C)]),
            emptyPage("bm2")
        ];
        let call = 0;
        const { session, received } = makeSession(async () => responses[call++]);

        session.start();
        await settle();

        expect(received).toEqual([
            { references: [A, B], bookmark: "bm1" },
            { references: [C], bookmark: "bm2" },
            { references: [], bookmark: "bm2" }
        ]);
        // The last frame is the SYNC frame: empty references, current bookmark.
        expect(received[received.length - 1].references).toEqual([]);
    });

    it("emits a SYNC frame immediately when there is no history", async () => {
        const { session, received } = makeSession(async () => emptyPage(""));

        session.start();
        await settle();

        expect(received).toEqual([{ references: [], bookmark: "" }]);
    });

    it("deduplicates facts across tuples within a page", async () => {
        const A = ref("Test.Post", "a");
        const B = ref("Test.Post", "b");
        const C = ref("Test.Post", "c");
        const responses = [
            page("bm1", [tuple(A, B), tuple(B, C)]),
            emptyPage("bm1")
        ];
        let call = 0;
        const { session, received } = makeSession(async () => responses[call++]);

        session.start();
        await settle();

        expect(received[0].references).toEqual([A, B, C]);
    });

    it("continues querying when facts arrive during a query (waitlist continuation)", async () => {
        const A = ref("Test.Post", "a");
        let call = 0;
        let sessionRef: FeedStreamSession | null = null;
        const query = jest.fn(async () => {
            call++;
            if (call === 1) {
                // A fact arrives mid-query: enqueue it onto the waitlist.
                sessionRef!.onInverseMatch([A]);
                return emptyPage("");
            }
            if (call === 2) {
                return page("bm1", [tuple(A)]);
            }
            return emptyPage("bm1");
        });
        const made = makeSession(query);
        sessionRef = made.session;

        made.session.start();
        await settle();

        // First empty + waitlist non-empty triggered a re-query that found A,
        // then a final empty query produced the SYNC frame.
        expect(made.received).toEqual([
            { references: [A], bookmark: "bm1" },
            { references: [], bookmark: "bm1" }
        ]);
        expect(query).toHaveBeenCalledTimes(3);
    });

    it("removes a fact from the waitlist only when its tuple is streamed", async () => {
        const A = ref("Test.Post", "a");
        const responses = [
            page("bm1", [tuple(A)]),
            emptyPage("bm1")
        ];
        let call = 0;
        const { session, received } = makeSession(async () => responses[call++ ] ?? emptyPage("bm1"));

        session.onInverseMatch([A]);
        expect(session.waitlistSize).toBe(1);
        await settle();

        // Once A's tuple is streamed, it is removed and the cycle reaches SYNC.
        expect(session.waitlistSize).toBe(0);
        expect(received).toEqual([
            { references: [A], bookmark: "bm1" },
            { references: [], bookmark: "bm1" }
        ]);
    });

    it("drops stale waitlist entries that never complete and emits SYNC", async () => {
        const A = ref("Test.Post", "a");
        const { session, received } = makeSession(async () => emptyPage(""));

        session.onInverseMatch([A]);
        expect(session.waitlistSize).toBe(1);
        await settle();

        // The query never returns A's tuple and no new trigger arrives, so the
        // stale entry is dropped and a SYNC frame is emitted.
        expect(session.waitlistSize).toBe(0);
        expect(received).toEqual([{ references: [], bookmark: "" }]);
    });

    it("runs only one cycle at a time", async () => {
        const A = ref("Test.Post", "a");
        let concurrent = 0;
        let maxConcurrent = 0;
        let call = 0;
        const query = jest.fn(async (_bookmark: string) => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise<void>(resolve => setImmediate(resolve));
            concurrent--;
            call++;
            return emptyPage("");
        });
        const { session } = makeSession(query);

        // Fire several wake-ups in quick succession.
        session.onInverseMatch([A]);
        session.onInverseMatch([A]);
        session.onInverseMatch([A]);
        await settle();

        expect(maxConcurrent).toBe(1);
    });

    it("caps the waitlist and closes the stream when exceeded", async () => {
        const stream = new Stream<FeedResponse>();
        const closeSpy = jest.spyOn(stream, "close");
        // A query that never advances so the cycle cannot drain the waitlist.
        const { session, factManager } = makeSession(
            async () => emptyPage(""),
            { stream, config: { waitlistCap: 2 } }
        );

        session.onInverseMatch([
            ref("Test.Post", "a"),
            ref("Test.Post", "b"),
            ref("Test.Post", "c")
        ]);

        expect(closeSpy).toHaveBeenCalled();
        // Listeners are torn down on graceful close.
        expect(factManager.removed.length).toBe(factManager.listeners.length);
    });

    it("stops after the configured maximum number of pages", async () => {
        let call = 0;
        const query = jest.fn(async () => page(`bm${++call}`, [tuple(ref("Test.Post", `p${call}`))]));
        const { session, received } = makeSession(query, { config: { maxInitialPages: 2, pageDelayEvery: 0 } });

        session.start();
        await settle();

        // Exactly two pages streamed, then the cycle stops (no SYNC frame).
        expect(query).toHaveBeenCalledTimes(2);
        expect(received.length).toBe(2);
        expect(received.every(r => r.references.length > 0)).toBe(true);
    });

    it("keeps the stream alive without SYNC when a query is denied", async () => {
        const denied: FeedResult = { type: "denied", reason: "not authorized" };
        const { session, received, stream } = makeSession(async () => denied);

        session.start();
        await settle();

        expect(received).toEqual([]);
        // Stream remains open so a later authorizing fact can wake the cycle.
        expect((stream as any).closed).toBe(false);
    });

    it("only enqueues inverse results whose given subset matches", async () => {
        const A = ref("Test.Post", "a");
        const query = jest.fn(async () => emptyPage(""));
        const { session, factManager } = makeSession(query);

        session.start();
        await settle();
        query.mockClear();

        const inverseListener = factManager.listeners[0];
        expect(inverseListener).toBeDefined();

        // A result whose tuple does not match this subscription's given.
        const nonMatching: ProjectedResult = {
            tuple: { p: ref("Jinaga.User", "someone-else"), post: A },
            result: A
        };
        await inverseListener.onResult([nonMatching]);
        await settle();

        // The non-matching result is filtered out: no new cycle/query runs.
        expect(query).not.toHaveBeenCalled();
        expect(session.waitlistSize).toBe(0);
    });

    it("removes all listeners and stops cycling on dispose", async () => {
        const A = ref("Test.Post", "a");
        const query = jest.fn(async () => emptyPage(""));
        const { session, factManager } = makeSession(query);

        session.start();
        await settle();
        const registered = factManager.listeners.length;
        expect(registered).toBeGreaterThan(0);

        session.dispose();
        expect(factManager.removed.length).toBe(registered);

        query.mockClear();
        // After dispose, further triggers are ignored.
        session.onInverseMatch([A]);
        await settle();
        expect(query).not.toHaveBeenCalled();
    });
});
