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

// Regression coverage for scenarios the primary unit spec does not exercise:
// a store whose bookmark actually advances across a real-time update, recovery
// of a fact that was dropped from the waitlist as "stale", and disposal while
// a query is in flight. These lock down the core streaming guarantees against
// future changes to the cycle/waitlist logic.

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
    return { type: "success", feed: { tuples, bookmark } as FactFeed };
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
        "regression-conn",
        options.config ?? {}
    );
    return { session, stream, received, factManager };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

describe("FeedStreamSession regression", () => {
    it("delivers a post-SYNC update on a paginating store and advances the bookmark", async () => {
        const A = ref("Test.Post", "a");
        const B = ref("Test.Post", "b");
        // A realistic paginating store keyed by bookmark: A is history at "";
        // after SYNC, B is delivered past "bm1" and the bookmark moves to "bm2".
        const query = jest.fn(async (bookmark: string) => {
            if (bookmark === "") return page("bm1", [tuple(A)]);
            if (bookmark === "bm1") return emptyPage("bm1");
            if (bookmark === "bm1+B") return page("bm2", [tuple(B)]);
            return emptyPage("bm2");
        });
        // Second cycle needs a distinct bookmark once B is available; emulate
        // that by having onInverseMatch flip the store's view.
        let bReady = false;
        const wrapped = jest.fn(async (bookmark: string) => {
            if (bookmark === "bm1" && bReady) return page("bm2", [tuple(B)]);
            return query(bookmark);
        });
        const { session, received } = makeSession(wrapped, { config: { pageDelayEvery: 0 } });

        session.start();
        await settle();
        // Backfill delivered A then a SYNC frame at bm1.
        expect(received).toEqual([
            { references: [A], bookmark: "bm1" },
            { references: [], bookmark: "bm1" }
        ]);

        // A real-time update arrives after SYNC.
        bReady = true;
        session.onInverseMatch([B]);
        await settle();

        expect(received.slice(2)).toEqual([
            { references: [B], bookmark: "bm2" },
            { references: [], bookmark: "bm2" }
        ]);
        // Bookmark advanced monotonically and never regressed.
        expect(received.map(r => r.bookmark)).toEqual(["bm1", "bm1", "bm2", "bm2"]);
    });

    it("re-delivers a fact that was dropped as stale once a later trigger makes it completable", async () => {
        const A = ref("Test.Post", "a");
        let completable = false;
        // Bookmark-respecting store: A only becomes visible past "" once its
        // tuple is completable; afterward the bookmark advances to "bm1".
        const query = jest.fn(async (bookmark: string) => {
            if (completable && bookmark === "") return page("bm1", [tuple(A)]);
            return emptyPage(bookmark === "" ? "" : "bm1");
        });
        const { session, received } = makeSession(query);

        // First trigger: A's tuple cannot complete, so it is dropped and a
        // SYNC frame is emitted without ever delivering A.
        session.onInverseMatch([A]);
        await settle();
        expect(received).toEqual([{ references: [], bookmark: "" }]);
        expect(session.waitlistSize).toBe(0);

        // A becomes completable; a later trigger re-adds it and it is delivered.
        completable = true;
        session.onInverseMatch([A]);
        await settle();
        expect(received.slice(1)).toEqual([
            { references: [A], bookmark: "bm1" },
            { references: [], bookmark: "bm1" }
        ]);
    });

    it("does not run concurrent cycles under a burst of triggers", async () => {
        let concurrent = 0;
        let maxConcurrent = 0;
        const query = jest.fn(async () => {
            concurrent++;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise<void>(resolve => setImmediate(resolve));
            concurrent--;
            return emptyPage("");
        });
        const A = ref("Test.Post", "a");
        const { session } = makeSession(query);

        session.start();
        for (let i = 0; i < 8; i++) {
            session.onInverseMatch([A]);
        }
        await settle();

        expect(maxConcurrent).toBe(1);
    });

    it("streams nothing once disposed while a query is in flight", async () => {
        const A = ref("Test.Post", "a");
        let resolveQuery: (value: FeedResult) => void = () => { };
        const query = jest.fn(() => new Promise<FeedResult>(resolve => { resolveQuery = resolve; }));
        const { session, received } = makeSession(query);

        session.start();
        // Let the cycle enter the awaited query.
        await new Promise<void>(resolve => setImmediate(resolve));

        // Dispose mid-query, then let the query resolve with a full page.
        session.dispose();
        resolveQuery(page("bm1", [tuple(A)]));
        await settle();

        // The post-dispose page must not be streamed.
        expect(received).toEqual([]);
    });
});
