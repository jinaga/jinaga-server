import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    FactManager,
    FeedCache,
    FeedResponse,
    MemoryStore,
    NetworkNoOp,
    NoOpTracer,
    ObservableSource,
    PassThroughFork,
    Trace,
    Tracer,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { feedKeys } from "../../src/feeds/feed-identity";
import { traceFeedUsage } from "../../src/feeds/feed-usage";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { Stream } from "../../src/http/stream";
import { MemoryKeystore } from "../../src/memory/memory-keystore";
import { FakeClock } from "../util/fake-clock";

class Post {
    public static Type = "usage.Post" as const;
    public type = Post.Type;
    constructor(public author: User, public body: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Post, m => m.predecessor("author", User))
);

const userIdentity = { provider: "mock", id: "subscriber" };

// Records Trace.metric calls so a test can read the windowed feed-usage
// report without grepping logs. Everything else is a no-op, and
// dependency() still runs its operation so the polling handler works.
class CapturingTracer extends NoOpTracer implements Tracer {
    public readonly metrics: { message: string; measurements: { [key: string]: number } }[] = [];
    metric(message: string, measurements: { [key: string]: number }): void {
        this.metrics.push({ message, measurements });
    }
}

interface Harness {
    router: HttpRouter;
    factManager: FactManager;
    feedCache: FeedCache;
    requestUser: RequestUser;
    author: User;
    authorHash: string;
    secondAuthorHash: string;
    /**
     * Every bookmark the authorization layer was asked to read, in order.
     * This is the independent count of feed queries: the accounting is
     * correct exactly when it reports these and no others.
     */
    queriedBookmarks: string[];
}

async function makeHarness(): Promise<Harness> {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();
    const userFact = await keystore.getOrCreateUserFact(userIdentity);
    const author = new User(userFact.fields.publicKey);
    const authorHash = dehydrateFact(author)[0].hash;
    const secondAuthorHash = dehydrateFact(new User("another-public-key"))[0].hash;

    const fork = new PassThroughFork(storage);
    const observable = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observable, storage, network, []);

    const authorizationRules = new AuthorizationRules(model)
        .any(User)
        .any(Post);
    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, null);

    // Count the feed queries at the layer below the router, so the test's
    // expectation of "k + m reads" is derived from the queries that were
    // actually run rather than restated from the code under test.
    const queriedBookmarks: string[] = [];
    for (const method of ["feedWithDistribution", "feedPreVerified"] as const) {
        const original = (authorization as any)[method].bind(authorization);
        (authorization as any)[method] = (
            identity: unknown, specification: unknown, start: unknown, bookmark: string
        ) => {
            queriedBookmarks.push(bookmark);
            return original(identity, specification, start, bookmark);
        };
    }

    const feedCache = new FeedCache();
    const router = new HttpRouter(factManager, authorization, feedCache, "*");

    return {
        router,
        factManager,
        feedCache,
        requestUser: { provider: userIdentity.provider, id: userIdentity.id, profile: {} as any },
        author,
        authorHash,
        secondAuthorHash,
        queriedBookmarks
    };
}

async function subscribe(h: Harness, authorHash: string): Promise<string> {
    const input =
        `let p: Jinaga.User = #${authorHash}\n` +
        `(p: Jinaga.User) {\n` +
        `    post: ${Post.Type} [\n` +
        `        post->author: Jinaga.User = p\n` +
        `    ]\n` +
        `} => post`;
    const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
    expect(feedsResponse.feeds.length).toBeGreaterThan(0);
    return feedsResponse.feeds[0];
}

async function instanceKeyOfFeed(h: Harness, feedHash: string): Promise<string> {
    const definition = await h.feedCache.getFeed(feedHash);
    expect(definition).toBeTruthy();
    return feedKeys(definition!).instanceKey;
}

function usageOf(h: Harness, instanceKey: string) {
    const usage = h.router.feedUsage.usage(instanceKey);
    expect(usage).toBeTruthy();
    return usage!;
}

async function poll(h: Harness, feedHash: string, bookmark: string): Promise<void> {
    await (h.router as any).feed(h.requestUser, { hash: feedHash }, bookmark ? { b: bookmark } : {});
}

async function drain(): Promise<void> {
    for (let i = 0; i < 8; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

afterEach(() => {
    Trace.configure(new NoOpTracer());
    jest.restoreAllMocks();
});

describe("feed usage accounting", () => {
    it("counts the polling reads and the streaming cycle queries of one instance", async () => {
        const h = await makeHarness();
        const feedHash = await subscribe(h, h.authorHash);
        const key = await instanceKeyOfFeed(h, feedHash);

        // k polling reads: two from the beginning of the feed and two from
        // a bookmark.
        await poll(h, feedHash, "");
        await poll(h, feedHash, "9.4");
        await poll(h, feedHash, "");
        await poll(h, feedHash, "7.12");
        const pollingReads = h.queriedBookmarks.length;
        expect(pollingReads).toBe(4);

        // m streaming cycle queries: the session's initial cycle, plus a
        // cycle woken by a save.
        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        await drain();
        await h.factManager.save(dehydrateFact(new Post(h.author, "first"))
            .map(f => ({ fact: f, signatures: [] })));
        await drain();
        stream.close();
        await drain();

        const streamingReads = h.queriedBookmarks.length - pollingReads;
        expect(streamingReads).toBeGreaterThan(0);

        const usage = usageOf(h, key);
        expect(usage.reads).toBe(pollingReads + streamingReads);
        expect(usage.readsFromEmptyBookmark)
            .toBe(h.queriedBookmarks.filter(b => b === "").length);
    });

    it("keeps the earliest bookmark any read started from, in the order the store pages", async () => {
        const h = await makeHarness();
        const feedHash = await subscribe(h, h.authorHash);
        const key = await instanceKeyOfFeed(h, feedHash);

        // 10.5 is later than 7.12 by position although it sorts first as
        // text, 7.300 is later than 7.12 although "300" sorts before "12",
        // and the empty bookmark is not a position at all.
        await poll(h, feedHash, "9.4");
        await poll(h, feedHash, "");
        await poll(h, feedHash, "7.12");
        await poll(h, feedHash, "7.300");
        await poll(h, feedHash, "10.5");

        expect(usageOf(h, key).earliestBookmark).toBe("7.12");
    });

    it("accounts each read against the instance that was read", async () => {
        const h = await makeHarness();
        const firstFeed = await subscribe(h, h.authorHash);
        const secondFeed = await subscribe(h, h.secondAuthorHash);
        const firstKey = await instanceKeyOfFeed(h, firstFeed);
        const secondKey = await instanceKeyOfFeed(h, secondFeed);
        expect(secondKey).not.toBe(firstKey);

        await poll(h, firstFeed, "");
        await poll(h, firstFeed, "");
        await poll(h, secondFeed, "");

        expect(usageOf(h, firstKey).reads).toBe(2);
        expect(usageOf(h, secondKey).reads).toBe(1);
    });

    it("moves the open session count up when a stream opens and back down when it closes", async () => {
        const h = await makeHarness();
        const feedHash = await subscribe(h, h.authorHash);
        const key = await instanceKeyOfFeed(h, feedHash);

        const first: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        await drain();
        expect(usageOf(h, key).openStreamingSessions).toBe(1);

        const second: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        await drain();
        expect(usageOf(h, key).openStreamingSessions).toBe(2);

        second.close();
        await drain();
        expect(usageOf(h, key).openStreamingSessions).toBe(1);

        first.close();
        await drain();
        expect(usageOf(h, key).openStreamingSessions).toBe(0);
    });

    it("counts the inverse matches delivered for a shape", async () => {
        const h = await makeHarness();
        const feedHash = await subscribe(h, h.authorHash);
        const definition = await h.feedCache.getFeed(feedHash);
        const keys = feedKeys(definition!);

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        await drain();
        expect(h.router.feedUsage.inverseMatches(keys.shapeKey)).toBe(0);

        await h.factManager.save(dehydrateFact(new Post(h.author, "first"))
            .map(f => ({ fact: f, signatures: [] })));
        await drain();
        stream.close();

        expect(h.router.feedUsage.inverseMatches(keys.shapeKey)).toBeGreaterThan(0);
    });

    it("reports one metric per instance read in the window, and nothing in a quiet window", async () => {
        const h = await makeHarness();
        const firstFeed = await subscribe(h, h.authorHash);
        const secondFeed = await subscribe(h, h.secondAuthorHash);
        const firstKey = await instanceKeyOfFeed(h, firstFeed);
        const secondKey = await instanceKeyOfFeed(h, secondFeed);

        const tracer = new CapturingTracer();
        Trace.configure(tracer);
        const clock = new FakeClock();
        clock.install();
        const windowMilliseconds = 10000;
        const stopReporting = traceFeedUsage(h.router.feedUsage, windowMilliseconds);
        try {
            // The window closes on a timer that does not hold the process
            // open, as the pool's does.
            expect(clock.only().delay).toBe(windowMilliseconds);
            expect(clock.only().hasRef()).toBe(false);

            // A window with no reads reports nothing.
            clock.advance(windowMilliseconds);
            expect(tracer.metrics).toHaveLength(0);

            // A window with reads of two instances reports exactly two.
            await poll(h, firstFeed, "");
            await poll(h, firstFeed, "");
            await poll(h, secondFeed, "");
            clock.advance(windowMilliseconds);

            expect(tracer.metrics).toHaveLength(2);
            expect(tracer.metrics.map(m => m.message).sort()).toEqual([
                `Feed usage ${usageOf(h, firstKey).shapeKey} ${firstKey}`,
                `Feed usage ${usageOf(h, secondKey).shapeKey} ${secondKey}`
            ].sort());
            const first = tracer.metrics.find(m => m.message.endsWith(firstKey))!;
            expect(first.measurements.readsInWindow).toBe(2);
            expect(first.measurements.reads).toBe(2);

            // The next window is quiet again, so it reports nothing more,
            // and the totals survive it.
            clock.advance(windowMilliseconds);
            expect(tracer.metrics).toHaveLength(2);
            expect(usageOf(h, firstKey).reads).toBe(2);

            // A read after a quiet window reports this window's reads and
            // the totals that accumulated across both.
            await poll(h, firstFeed, "");
            clock.advance(windowMilliseconds);
            expect(tracer.metrics).toHaveLength(3);
            expect(tracer.metrics[2].measurements.readsInWindow).toBe(1);
            expect(tracer.metrics[2].measurements.reads).toBe(3);
        }
        finally {
            stopReporting();
        }
        expect(clock.live()).toHaveLength(0);
    });
});
