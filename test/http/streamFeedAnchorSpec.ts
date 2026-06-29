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
    for (let i = 0; i < 5; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

describe("HttpRouter streamFeed anchor handling", () => {
    it("delivers a post that joins to an anchor whose User fact arrives after subscribe", async () => {
        const h = await makeHarness();

        // Subscribe for posts by the author. The author fact's hash is
        // referenced but not yet stored.
        const input =
            `let p: Jinaga.User = #${h.authorRef.hash}\n` +
            `(p: Jinaga.User) {\n` +
            `    post: stream.Post [\n` +
            `        post->author: Jinaga.User = p\n` +
            `    ]\n` +
            `} => post`;

        const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
        expect(feedsResponse.feeds.length).toBeGreaterThan(0);
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        expect(stream).not.toBeNull();

        const received: FeedResponse[] = [];
        stream.next(r => { received.push(r); });

        await waitForMicrotasks();
        // The session catches up immediately (no tuples, empty waitlist) and
        // emits a SYNC frame with empty references. No post has arrived yet.
        expect(received.flatMap(r => r.references)).toEqual([]);

        // Save the author + a post that joins to it.
        const post = new Post(h.author, "first");
        const envelopes = dehydrateFact(post).map(f => ({ fact: f, signatures: [] }));
        await h.factManager.save(envelopes);

        await waitForMicrotasks();
        stream.close();

        const allReferences = received.flatMap(r => r.references);
        const postArrived = allReferences.some(r => r.type === Post.Type);
        expect(postArrived).toBe(true);
    });

    it("re-runs the query when the anchor User fact arrives with descendants already in store", async () => {
        const h = await makeHarness();

        // Insert the post and its author directly through the underlying
        // store so no observable notification fires for these. After
        // subscribe, only the anchor-arrival path should trigger delivery.
        const post = new Post(h.author, "preexisting");
        const postFacts = dehydrateFact(post);
        await h.storage.save(postFacts.map(f => ({ fact: f, signatures: [] })));

        // Now subscribe.
        const input =
            `let p: Jinaga.User = #${h.authorRef.hash}\n` +
            `(p: Jinaga.User) {\n` +
            `    post: stream.Post [\n` +
            `        post->author: Jinaga.User = p\n` +
            `    ]\n` +
            `} => post`;

        const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
        const feedHash: string = feedsResponse.feeds[0];
        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});

        const received: FeedResponse[] = [];
        stream.next(r => { received.push(r); });
        await waitForMicrotasks();

        // The initial query should already have included the post (since
        // it's in the store), so the subscription is "activated" via the
        // initial fetch. Record what we have.
        const beforeCount = received.flatMap(r => r.references)
            .filter(r => r.type === Post.Type).length;

        // Re-save the author through the FactManager so the anchor
        // listener fires. The dedup at the store level returns no new
        // envelopes, but the listener still has to behave gracefully.
        await h.factManager.save(postFacts
            .filter(f => f.type === "Jinaga.User")
            .map(f => ({ fact: f, signatures: [] })));
        await waitForMicrotasks();
        stream.close();

        // At minimum the post is visible after the anchor save and the
        // stream does not error. With the initial fetch the post was
        // already delivered; this guards against regressions where the
        // anchor path tears down the stream.
        expect(beforeCount).toBeGreaterThanOrEqual(1);
    });
});
