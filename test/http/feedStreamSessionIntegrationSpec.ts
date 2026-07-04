import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    FactManager,
    FeedCache,
    FeedResponse,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { Stream } from "../../src/http/stream";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// End-to-end coverage of the FeedStreamSession wired through HttpRouter
// against a real in-memory FactManager. Exercises backfill, mid-backfill
// inserts, the SYNC frame, and post-SYNC real-time updates.
class Post {
    public static Type = "stream.Post" as const;
    public type = Post.Type;
    constructor(public author: User, public body: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Post, m => m.predecessor("author", User))
);

const userIdentity = { provider: "mock", id: "subscriber" };

interface Harness {
    router: HttpRouter;
    factManager: FactManager;
    storage: MemoryStore;
    requestUser: RequestUser;
    author: User;
    authorRef: { type: string; hash: string };
}

async function makeHarness(): Promise<Harness> {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();
    const userFact = await keystore.getOrCreateUserFact(userIdentity);
    const author = new User(userFact.fields.publicKey);
    const authorRef = dehydrateFact(author)[0];

    const fork = new PassThroughFork(storage);
    const observable = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observable, storage, network, []);

    const authorizationRules = new AuthorizationRules(model)
        .any(User)
        .any(Post);
    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, null);
    const feedCache = new FeedCache();

    const router = new HttpRouter(factManager, authorization, feedCache, "*");

    return {
        router,
        factManager,
        storage,
        requestUser: { provider: userIdentity.provider, id: userIdentity.id, profile: {} as any },
        author,
        authorRef
    };
}

async function waitForMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

function feedInput(authorHash: string): string {
    return (
        `let p: Jinaga.User = #${authorHash}\n` +
        `(p: Jinaga.User) {\n` +
        `    post: stream.Post [\n` +
        `        post->author: Jinaga.User = p\n` +
        `    ]\n` +
        `} => post`
    );
}

async function savePost(h: Harness, body: string): Promise<void> {
    const post = new Post(h.author, body);
    const envelopes = dehydrateFact(post).map(f => ({ fact: f, signatures: [] }));
    await h.factManager.save(envelopes);
}

describe("HttpRouter streamFeed session integration", () => {
    it("backfills all historical posts and ends with a SYNC frame", async () => {
        const h = await makeHarness();
        await h.factManager.save(dehydrateFact(h.author).map(f => ({ fact: f, signatures: [] })));
        for (let i = 0; i < 5; i++) {
            await savePost(h, `post-${i}`);
        }

        const feedsResponse = await (h.router as any).feeds(h.requestUser, feedInput(h.authorRef.hash));
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        const received: FeedResponse[] = [];
        stream.next(r => received.push(r));

        await waitForMicrotasks();
        stream.close();

        const distinctPosts = new Set(received.flatMap(r => r.references)
            .filter(r => r.type === Post.Type).map(r => r.hash));
        expect(distinctPosts.size).toBe(5);
        // The final frame is the SYNC signal: empty references.
        expect(received[received.length - 1].references).toEqual([]);
    });

    it("does not lose posts inserted during backfill", async () => {
        const h = await makeHarness();
        await h.factManager.save(dehydrateFact(h.author).map(f => ({ fact: f, signatures: [] })));
        await savePost(h, "historical");

        const feedsResponse = await (h.router as any).feeds(h.requestUser, feedInput(h.authorRef.hash));
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        const received: FeedResponse[] = [];
        stream.next(r => received.push(r));

        // Insert a post immediately, racing the backfill.
        await savePost(h, "raced");
        await waitForMicrotasks();
        stream.close();

        const distinctPosts = new Set(received.flatMap(r => r.references)
            .filter(r => r.type === Post.Type).map(r => r.hash));
        // Both the historical and the raced post are delivered.
        expect(distinctPosts.size).toBe(2);
        expect(received[received.length - 1].references).toEqual([]);
    });

    it("delivers post-SYNC updates in subsequent frames", async () => {
        const h = await makeHarness();
        await h.factManager.save(dehydrateFact(h.author).map(f => ({ fact: f, signatures: [] })));

        const feedsResponse = await (h.router as any).feeds(h.requestUser, feedInput(h.authorRef.hash));
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        const received: FeedResponse[] = [];
        stream.next(r => received.push(r));

        await waitForMicrotasks();
        const framesBeforeUpdate = received.length;
        // The first frame is the immediate SYNC (no history).
        expect(received[framesBeforeUpdate - 1].references).toEqual([]);

        // A new post after SYNC should arrive in a later frame.
        await savePost(h, "after-sync");
        await waitForMicrotasks();
        stream.close();

        const newFrames = received.slice(framesBeforeUpdate);
        const distinctPosts = new Set(newFrames.flatMap(r => r.references)
            .filter(r => r.type === Post.Type).map(r => r.hash));
        expect(distinctPosts.size).toBe(1);
    });

    it("cleans up listeners on disconnect", async () => {
        const h = await makeHarness();
        await h.factManager.save(dehydrateFact(h.author).map(f => ({ fact: f, signatures: [] })));

        const removeSpy = jest.spyOn(h.factManager, "removeSpecificationListener");

        const feedsResponse = await (h.router as any).feeds(h.requestUser, feedInput(h.authorRef.hash));
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        stream.next(() => { });
        await waitForMicrotasks();

        const removedBefore = removeSpy.mock.calls.length;
        stream.close();

        // Closing the stream disposes the session, removing every listener.
        expect(removeSpy.mock.calls.length).toBeGreaterThan(removedBefore);

        // A post saved after disconnect must not reach the closed stream.
        await savePost(h, "after-close");
        await waitForMicrotasks();
    });
});
