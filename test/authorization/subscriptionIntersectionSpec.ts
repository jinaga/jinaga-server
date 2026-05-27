import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactManager,
    hydrate,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    ReferencesByName,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

class Company {
    public static Type = "Company" as const;
    public type = Company.Type;
    constructor(public creator: User, public name: string) { }
}

class Office {
    public static Type = "Office" as const;
    public type = Office.Type;
    constructor(public company: Company, public name: string) { }
}

class Administrator {
    public static Type = "Administrator" as const;
    public type = Administrator.Type;
    constructor(public company: Company, public user: User, public createdAt: Date | string) { }
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

describe("AuthorizationKeystore.verifyDistributionOrIntersect", () => {
    it("returns the original spec when the user is already authorized", async () => {
        const setup = await givenAuthorizationWithDistribution(true, async (subscriber, creator) => {
            const company = new Company(creator, "Acme");
            const admin = new Administrator(company, subscriber, new Date("2026-05-26"));
            return { company, admin };
        });

        const officeSpec = model.given(Company).match((c, facts) =>
            facts.ofType(Office).join(o => o.company, c)
        ).specification;
        const companyRef = dehydrateFact(setup.seeded.company)
            .find(f => f.type === Company.Type)!;
        const namedStart: ReferencesByName = { [officeSpec.given[0].label.name]: companyRef };

        const branches = await setup.authorization.verifyDistributionOrIntersect(
            subscriberIdentity, officeSpec, namedStart);

        expect(branches).toHaveLength(1);
        expect(branches[0].specification).toBe(officeSpec);
        expect(branches[0].start).toEqual([companyRef]);
    });

    it("returns intersected branches when the user is not yet authorized", async () => {
        const setup = await givenAuthorizationWithDistribution(true, async (subscriber, creator) => {
            const company = new Company(creator, "Acme");
            // No Administrator yet — subscriber is not authorized.
            return { company };
        });

        const officeSpec = model.given(Company).match((c, facts) =>
            facts.ofType(Office).join(o => o.company, c)
        ).specification;
        const companyRef = dehydrateFact(setup.seeded.company)
            .find(f => f.type === Company.Type)!;
        const namedStart: ReferencesByName = { [officeSpec.given[0].label.name]: companyRef };

        const branches = await setup.authorization.verifyDistributionOrIntersect(
            subscriberIdentity, officeSpec, namedStart);

        // Intersection produced an alternate branch that lifts the rule's
        // user-spec into the subscription. The intersected spec has an
        // additional synthetic given and a different shape than the original.
        expect(branches.length).toBeGreaterThanOrEqual(1);
        expect(branches[0].specification).not.toBe(officeSpec);
        expect(branches[0].specification.given.length).toBe(2);
        // The synthetic given is bound to the subscriber's user fact.
        expect(branches[0].start[1]).toEqual({
            type: setup.subscriberFact.type,
            hash: setup.subscriberFact.hash
        });
    });

    it("throws Forbidden when no distribution rule applies to the spec", async () => {
        const setup = await givenAuthorizationWithDistribution(true, async (_subscriber, creator) => {
            const company = new Company(creator, "Acme");
            return { company };
        });

        // A spec the rule doesn't cover at all (different fact type).
        const unrelatedSpec = model.given(Company).match((c, facts) =>
            facts.ofType(Administrator).join(a => a.company, c)
        ).specification;
        const companyRef = dehydrateFact(setup.seeded.company)
            .find(f => f.type === Company.Type)!;
        const namedStart: ReferencesByName = { [unrelatedSpec.given[0].label.name]: companyRef };

        await expect(
            setup.authorization.verifyDistributionOrIntersect(
                subscriberIdentity, unrelatedSpec, namedStart)
        ).rejects.toThrow();
    });

    it("returns a passthrough branch when there are no distribution rules at all", async () => {
        const setup = await givenAuthorizationWithDistribution(false, async (_subscriber, creator) => {
            const company = new Company(creator, "Acme");
            return { company };
        });

        const officeSpec = model.given(Company).match((c, facts) =>
            facts.ofType(Office).join(o => o.company, c)
        ).specification;
        const companyRef = dehydrateFact(setup.seeded.company)
            .find(f => f.type === Company.Type)!;
        const namedStart: ReferencesByName = { [officeSpec.given[0].label.name]: companyRef };

        const branches = await setup.authorization.verifyDistributionOrIntersect(
            subscriberIdentity, officeSpec, namedStart);

        expect(branches).toHaveLength(1);
        expect(branches[0].specification).toBe(officeSpec);
    });
});

async function givenAuthorizationWithDistribution<T extends Record<string, any>>(
    withDistributionRules: boolean,
    buildFacts: (subscriber: User, creator: User) => Promise<T>
) {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();

    const subscriberFact = await keystore.getOrCreateUserFact(subscriberIdentity);
    const creatorFact = await keystore.getOrCreateUserFact(creatorIdentity);
    const subscriber = new User(subscriberFact.fields.publicKey);
    const creator = new User(creatorFact.fields.publicKey);

    const seeded = await buildFacts(subscriber, creator);
    const facts = [
        ...dehydrateFact(subscriber),
        ...dehydrateFact(creator),
        ...Object.values(seeded).flatMap(v => dehydrateFact(v))
    ];
    // Dedupe by hash+type to avoid double-saving the shared predecessors.
    const seenKeys = new Set<string>();
    const uniqueFacts = facts.filter(f => {
        const k = `${f.type}|${f.hash}`;
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
    });
    await storage.save(uniqueFacts.map(f => ({ fact: f, signatures: [] })));

    const fork = new PassThroughFork(storage);
    const observable = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observable, storage, network, []);

    const authorizationRules = new AuthorizationRules(model)
        .no(User)
        .any(Company)
        .any(Office)
        .any(Administrator);

    const distributionRules = withDistributionRules
        ? new DistributionRules([])
            .share(model.given(Company).match((c, facts) =>
                facts.ofType(Office).join(o => o.company, c)
            ))
            .with(model.given(Company).match((c, facts) =>
                facts.ofType(Administrator)
                    .join(a => a.company, c)
                    .selectMany(a => facts.ofType(User).join(u => u, a.user))
            ))
        : null;

    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, distributionRules);
    return {
        authorization,
        subscriberFact,
        seeded: seeded as T & { company: Company }
    };
}
