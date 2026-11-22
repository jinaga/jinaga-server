import {
    DistributionRules,
    FactFeed,
    FactManager,
    FactReference,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    ReferencesByName,
    Specification,
    User,
    dehydrateFact
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { MemoryKeystore } from "../../src/memory/memory-keystore";
import { Post, Site, model } from "../models/blog";

/**
 * A store whose `feed` counts its calls and hands back a promise the test
 * settles by hand. Every other method is MemoryStore's, so the distribution
 * engine reads a real graph on its way to the feed query.
 */
class ControlledFeedStore extends MemoryStore {
    readonly feedCalls: { specification: Specification; start: FactReference[]; bookmark: string }[] = [];
    private readonly pending: { resolve(feed: FactFeed): void; reject(error: unknown): void }[] = [];

    feed(specification: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        this.feedCalls.push({ specification, start, bookmark });
        return new Promise<FactFeed>((resolve, reject) => {
            this.pending.push({ resolve, reject });
        });
    }

    get callCount(): number {
        return this.feedCalls.length;
    }

    settle(index: number, feed: FactFeed): void {
        this.pending[index].resolve(feed);
    }

    fail(index: number, error: unknown): void {
        this.pending[index].reject(error);
    }

    /**
     * Settle every read that is still outstanding. A test that expects one
     * merged read calls this so that an unmerged straggler fails on the call
     * count rather than hanging on a promise nobody resolves.
     */
    settleAll(feed: FactFeed): void {
        for (let index = 0; index < this.pending.length; index++) {
            this.pending[index].resolve(feed);
        }
    }

    /** Reject every outstanding read, for the same reason as `settleAll`. */
    failAll(error: unknown): void {
        for (let index = 0; index < this.pending.length; index++) {
            this.pending[index].reject(error);
        }
    }
}

/**
 * Yield until the store has recorded at least `count` reads, or until the
 * turn budget runs out. The distribution check reads the in-memory graph and
 * therefore settles in a bounded number of turns, so this waits on the
 * condition rather than on the clock.
 */
async function reachedStore(store: ControlledFeedStore, count: number): Promise<void> {
    for (let turn = 0; turn < 50 && store.callCount < count; turn++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

/**
 * Yield a fixed number of turns, to give every concurrent caller time to
 * arrive at the merge point before the shared read settles.
 */
async function settleTurns(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

function feedOf(bookmark: string, ...hashes: string[]): FactFeed {
    return {
        tuples: hashes.map(hash => ({
            facts: [{ type: Post.Type, hash }],
            bookmark
        })),
        bookmark
    };
}

const postsOfSite = model.given(Site).match((site, facts) =>
    facts.ofType(Post)
        .join(post => post.site, site)
);

const creatorIdentity = { provider: "test", id: "creator" };
const readerIdentities = [0, 1, 2, 3, 4].map(index => ({ provider: "test", id: `reader-${index}` }));

/**
 * Build an AuthorizationKeystore over a ControlledFeedStore holding two
 * sites. `share` decides who the posts feed is distributed to: `everyone`
 * for the merge criteria, `creatorOnly` so that one user is denied while
 * others are allowed.
 */
async function givenFeedAuthorization(share: "everyone" | "creatorOnly") {
    const store = new ControlledFeedStore();
    const keystore = new MemoryKeystore();

    const creatorFact = await keystore.getOrCreateUserFact(creatorIdentity);
    const creator = new User(creatorFact.fields.publicKey);
    for (const identity of readerIdentities) {
        await keystore.getOrCreateUserFact(identity);
    }

    const site = new Site(creator, "qedcode.com");
    const otherSite = new Site(creator, "jinaga.com");
    const records = [
        ...dehydrateFact(creator),
        ...dehydrateFact(site),
        ...dehydrateFact(otherSite)
    ];
    const seen = new Set<string>();
    const unique = records.filter(record => {
        const key = `${record.type}|${record.hash}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    await store.save(unique.map(fact => ({ fact, signatures: [] })));

    const siteRef = dehydrateFact(site).find(f => f.type === Site.Type)!;
    const otherSiteRef = dehydrateFact(otherSite).find(f => f.type === Site.Type)!;

    const factManager = new FactManager(
        new PassThroughFork(store),
        new ObservableSource(store),
        store,
        new NetworkNoOp(),
        []);

    const distributionRules = share === "everyone"
        ? new DistributionRules([])
            .share(postsOfSite)
            .withEveryone()
        : new DistributionRules([])
            .share(postsOfSite)
            .with(model.given(Site).match((site, facts) =>
                facts.ofType(User)
                    .join(user => user, site.creator)
            ));

    const authorization = new AuthorizationKeystore(
        factManager, store, keystore, null, distributionRules);

    return {
        store,
        authorization,
        specification: postsOfSite.specification,
        siteRef,
        otherSiteRef
    };
}

describe("AuthorizationKeystore feed read coalescing", () => {
    it("issues one store read for concurrent calls by different users on one specification, start and bookmark", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("everyone");

        const results = readerIdentities.map(identity =>
            authorization.feedWithDistribution(identity, specification, [siteRef], "b1"));

        await reachedStore(store, 1);
        await settleTurns();
        store.settleAll(feedOf("b2", "post-hash"));
        const settled = await Promise.all(results);

        expect(store.callCount).toBe(1);
        for (const result of settled) {
            expect(result.type).toBe("success");
            if (result.type !== "success") continue;
            expect(result.feed.bookmark).toBe("b2");
            expect(result.feed.tuples).toHaveLength(1);
            expect(result.feed.tuples[0].facts[0].hash).toBe("post-hash");
        }
    });

    it("issues one store read per bookmark for concurrent calls that differ only in bookmark", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("everyone");

        const first = authorization.feedWithDistribution(readerIdentities[0], specification, [siteRef], "b1");
        const second = authorization.feedWithDistribution(readerIdentities[1], specification, [siteRef], "b2");

        await reachedStore(store, 2);
        await settleTurns();
        store.settleAll(feedOf("b3", "post-hash"));
        await Promise.all([first, second]);

        expect(store.callCount).toBe(2);
        expect(store.feedCalls.map(call => call.bookmark)).toEqual(["b1", "b2"]);
    });

    it("issues one store read per start for concurrent calls that differ only in start", async () => {
        const { store, authorization, specification, siteRef, otherSiteRef } =
            await givenFeedAuthorization("everyone");

        const first = authorization.feedWithDistribution(readerIdentities[0], specification, [siteRef], "b1");
        const second = authorization.feedWithDistribution(readerIdentities[1], specification, [otherSiteRef], "b1");

        await reachedStore(store, 2);
        await settleTurns();
        store.settleAll(feedOf("b2", "post-hash"));
        await Promise.all([first, second]);

        expect(store.callCount).toBe(2);
        expect(store.feedCalls.map(call => call.start[0].hash))
            .toEqual([siteRef.hash, otherSiteRef.hash]);
    });

    it("issues a new store read once the previous read for that key has settled", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("everyone");

        const first = authorization.feedWithDistribution(readerIdentities[0], specification, [siteRef], "b1");
        await reachedStore(store, 1);
        store.settle(0, feedOf("b2", "first-post"));
        await first;

        const second = authorization.feedWithDistribution(readerIdentities[0], specification, [siteRef], "b1");
        await reachedStore(store, 2);
        expect(store.callCount).toBe(2);

        store.settle(1, feedOf("b3", "second-post"));
        const result = await second;

        expect(result.type).toBe("success");
        if (result.type !== "success") return;
        // The settled result was not reused: this call read the store again.
        expect(result.feed.bookmark).toBe("b3");
        expect(result.feed.tuples[0].facts[0].hash).toBe("second-post");
    });

    it("rejects every waiting call when the shared read rejects, and reads again on the next call", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("everyone");

        const waiting = readerIdentities.slice(0, 3).map(identity =>
            authorization.feedWithDistribution(identity, specification, [siteRef], "b1"));
        const observed = waiting.map(promise => promise.catch(error => error));

        await reachedStore(store, 1);
        await settleTurns();
        const failure = new Error("feed read failed");
        store.failAll(failure);
        const errors = await Promise.all(observed);

        expect(store.callCount).toBe(1);
        for (const error of errors) {
            expect(error).toBe(failure);
        }

        const retried = authorization.feedWithDistribution(
            readerIdentities[0], specification, [siteRef], "b1");
        await reachedStore(store, 2);
        expect(store.callCount).toBe(2);
        store.settle(1, feedOf("b2", "post-hash"));
        const result = await retried;
        expect(result.type).toBe("success");
    });

    it("denies a user whose distribution check fails while allowed users share one read", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("creatorOnly");

        const allowed = authorization.feedWithDistribution(creatorIdentity, specification, [siteRef], "b1");
        const denied = authorization.feedWithDistribution(readerIdentities[0], specification, [siteRef], "b1");
        const alsoAllowed = authorization.feedWithDistribution(creatorIdentity, specification, [siteRef], "b1");

        await reachedStore(store, 1);
        await settleTurns();
        store.settleAll(feedOf("b2", "post-hash"));
        const [allowedResult, deniedResult, alsoAllowedResult] =
            await Promise.all([allowed, denied, alsoAllowed]);

        expect(store.callCount).toBe(1);
        expect(deniedResult.type).toBe("denied");
        if (deniedResult.type === "denied") {
            expect(deniedResult.reason).toBeTruthy();
        }
        expect(allowedResult.type).toBe("success");
        expect(alsoAllowedResult.type).toBe("success");
        if (allowedResult.type === "success") {
            expect(allowedResult.feed.tuples).toHaveLength(1);
        }
    });

    it("shares one read between feedPreVerified and feedWithDistribution on the same key", async () => {
        const { store, authorization, specification, siteRef } = await givenFeedAuthorization("everyone");

        const preVerified = authorization.feedPreVerified(
            readerIdentities[0], specification, [siteRef], "b1");
        const checked = authorization.feedWithDistribution(
            readerIdentities[1], specification, [siteRef], "b1");

        await reachedStore(store, 1);
        await settleTurns();
        store.settleAll(feedOf("b2", "post-hash"));
        const preVerifiedFeed = await preVerified;
        const checkedResult = await checked;

        expect(store.callCount).toBe(1);
        expect(preVerifiedFeed.bookmark).toBe("b2");
        expect(checkedResult.type).toBe("success");
        if (checkedResult.type !== "success") return;
        expect(checkedResult.feed.bookmark).toBe("b2");
    });
});
