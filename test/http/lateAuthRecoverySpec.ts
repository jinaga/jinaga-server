import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
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

// Mirrors the jinaga.js #130 contract: a client who cannot yet read a
// feed must still be able to subscribe, receive an empty initial result,
// and start receiving rows the moment an authorizing fact arrives — all
// without the connection dying on a Forbidden.

class Office {
    public static Type = "late.Office" as const;
    public type = Office.Type;
    constructor(public company: Company, public name: string) { }
}

class Company {
    public static Type = "late.Company" as const;
    public type = Company.Type;
    constructor(public creator: User, public identifier: string) { }
}

class Administrator {
    public static Type = "late.Administrator" as const;
    public type = Administrator.Type;
    constructor(public company: Company, public user: User, public date: Date | string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Company, m => m.predecessor("creator", User))
    .type(Office, m => m.predecessor("company", Company))
    .type(Administrator, m => m
        .predecessor("company", Company)
        .predecessor("user", User))
);

const subscriberIdentity = { provider: "mock", id: "subscriber" };
const creatorIdentity = { provider: "mock", id: "creator" };

async function makeHarness() {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();
    const subscriberFact = await keystore.getOrCreateUserFact(subscriberIdentity);
    const creatorFact = await keystore.getOrCreateUserFact(creatorIdentity);
    const subscriber = new User(subscriberFact.fields.publicKey);
    const creator = new User(creatorFact.fields.publicKey);

    const fork = new PassThroughFork(storage);
    const observable = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observable, storage, network, []);

    const authorizationRules = new AuthorizationRules(model)
        .any(User)
        .any(Company)
        .any(Office)
        .any(Administrator);
    const distributionRules = new DistributionRules([])
        .share(model.given(Company).match((c, facts) =>
            facts.ofType(Office).join(o => o.company, c)
        ))
        .with(model.given(Company).match((c, facts) =>
            facts.ofType(Administrator)
                .join(a => a.company, c)
                .selectMany(a => facts.ofType(User).join(u => u, a.user))
        ));
    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, distributionRules);
    const feedCache = new FeedCache();
    const router = new HttpRouter(factManager, authorization, feedCache, "*");

    const requestUser: RequestUser = {
        provider: subscriberIdentity.provider,
        id: subscriberIdentity.id,
        profile: {} as any
    };
    return { router, factManager, subscriber, creator, storage, requestUser };
}

async function drainMicrotasks() {
    for (let i = 0; i < 8; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

describe("late-auth subscription recovery", () => {
    it("subscribes empty when not authorized and activates when the auth fact arrives", async () => {
        const h = await makeHarness();
        const company = new Company(h.creator, "Acme");
        const companyRef = dehydrateFact(company).find(f => f.type === Company.Type)!;
        // Seed the Company and an existing Office. The subscriber is not
        // yet an Administrator, so the rule denies them today.
        const existingOffice = new Office(company, "HQ");
        await h.factManager.save(dehydrateFact(existingOffice).map(f => ({ fact: f, signatures: [] })));

        // Use the same given label name the rule's specs produce
        // (`p1`, from `model.given(Company)`), so intersection can lift
        // the rule's path conditions onto the subscription's given.
        const input =
            `let p1: ${Company.Type} = #${companyRef.hash}\n` +
            `(p1: ${Company.Type}) {\n` +
            `    o: ${Office.Type} [\n` +
            `        o->company: ${Company.Type} = p1\n` +
            `    ]\n` +
            `} => o`;

        // POST /feeds must NOT throw Forbidden — the client is subscribing.
        const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
        expect(feedsResponse.feeds.length).toBeGreaterThan(0);
        const feedHash: string = feedsResponse.feeds[0];

        const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
            h.requestUser, { hash: feedHash }, {});
        expect(stream).not.toBeNull();

        const received: FeedResponse[] = [];
        stream.next(r => { received.push(r); });
        await drainMicrotasks();

        // Initial query is empty even though Office exists — the lifted
        // auth condition (Administrator → subscriber) is not satisfied.
        const initialOffices = received.flatMap(r => r.references)
            .filter(r => r.type === Office.Type);
        expect(initialOffices).toHaveLength(0);

        // The authorizing fact arrives: subscriber is granted Admin.
        const admin = new Administrator(company, h.subscriber, new Date("2026-05-27"));
        await h.factManager.save(dehydrateFact(admin).map(f => ({ fact: f, signatures: [] })));
        await drainMicrotasks();

        stream.close();

        // The pre-existing office surfaces as soon as the auth fact lands.
        const officesAfterAuth = received.flatMap(r => r.references)
            .filter(r => r.type === Office.Type);
        expect(officesAfterAuth.map(r => r.hash))
            .toContain(dehydrateFact(existingOffice).find(f => f.type === Office.Type)!.hash);
    });

    it("does not return a 403 from /feeds when no rule applies — connection stays available", async () => {
        const h = await makeHarness();

        // A spec the distribution rules do not cover at all. Step 1's
        // strict semantics would have thrown Forbidden here, but the
        // subscribe contract is to keep the connection live so the
        // client can wait for results (e.g., a future rule change).
        const company = new Company(h.creator, "Acme");
        const companyRef = dehydrateFact(company).find(f => f.type === Company.Type)!;
        await h.factManager.save(dehydrateFact(company).map(f => ({ fact: f, signatures: [] })));

        const input =
            `let p1: ${Company.Type} = #${companyRef.hash}\n` +
            `(p1: ${Company.Type}) {\n` +
            `    a: ${Administrator.Type} [\n` +
            `        a->company: ${Company.Type} = p1\n` +
            `    ]\n` +
            `} => a`;

        const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
        expect(feedsResponse.feeds.length).toBeGreaterThan(0);

        // Polling the cached feed must also stay live (empty page, not 403).
        const feedHash: string = feedsResponse.feeds[0];
        const page = await (h.router as any).feed(h.requestUser, { hash: feedHash }, {});
        expect(page).not.toBeNull();
        expect(page.references).toEqual([]);
    });
});
