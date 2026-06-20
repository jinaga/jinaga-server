import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactManager,
    Forbidden,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// Integration coverage for jinaga issue #204: a distribution rule whose
// `.select()` projection traverses *through* an intermediate fact (here
// `Finalist`, used only to reach the `competitor` it projects) must authorize an
// authorized user's direct query for that intermediate fact. The same
// DistributionEngine that JinagaTest uses also backs this server-side
// authorization path (`AuthorizationKeystore.read` -> `canDistributeToAll`,
// constructed with isTest=false), so the behavior must match.
//
// The sub-feed authorization relaxation this exercises landed in jinaga 6.8.2.

class Tenant {
    public static Type = "Tenant" as const;
    public type = Tenant.Type;
    constructor(public creator: User) { }
}

class Administrator {
    public static Type = "Administrator" as const;
    public type = Administrator.Type;
    constructor(public tenant: Tenant, public user: User, public createdAt: Date | string) { }
}

class Event {
    public static Type = "Event" as const;
    public type = Event.Type;
    constructor(public tenant: Tenant, public id: string) { }
}

class Competitor {
    public static Type = "Competitor" as const;
    public type = Competitor.Type;
    constructor(public tenant: Tenant) { }
}

// Finalist is the intermediate: the projection joins Event -> Finalist only to
// reach the Competitor predecessor; Finalist is never a named component.
class Finalist {
    public static Type = "Finalist" as const;
    public type = Finalist.Type;
    constructor(public competitor: Competitor, public event: Event) { }
}

class CompetitorName {
    public static Type = "CompetitorName" as const;
    public type = CompetitorName.Type;
    constructor(public competitor: Competitor, public value: string, public prior: CompetitorName[]) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Tenant, m => m.predecessor("creator", User))
    .type(Administrator, m => m
        .predecessor("tenant", Tenant)
        .predecessor("user", User))
    .type(Event, m => m.predecessor("tenant", Tenant))
    .type(Competitor, m => m.predecessor("tenant", Tenant))
    .type(Finalist, m => m
        .predecessor("competitor", Competitor)
        .predecessor("event", Event))
    .type(CompetitorName, m => m
        .predecessor("competitor", Competitor)
        .predecessor("prior", CompetitorName))
);

const finalistsOfEvent = model.given(Event).match((event, facts) =>
    facts.ofType(Finalist).join(finalist => finalist.event, event)
).specification;

const subscriberIdentity = { provider: "mock", id: "subscriber" };
const creatorIdentity = { provider: "mock", id: "creator" };

describe("AuthorizationKeystore.read with intermediate projection facts (jinaga #204)", () => {
    it("authorizes an administrator's direct query for an intermediate projection fact", async () => {
        const setup = await givenAuthorization(/* subscriberIsAdmin */ true);

        const eventRef = dehydrateFact(setup.event).find(f => f.type === Event.Type)!;

        // Should resolve (not throw Forbidden) and return the seeded finalist.
        const results = await setup.authorization.read(
            subscriberIdentity, [eventRef], finalistsOfEvent);

        expect(results).toHaveLength(1);
    });

    it("still denies a non-administrator's direct query for the same fact", async () => {
        const setup = await givenAuthorization(/* subscriberIsAdmin */ false);

        const eventRef = dehydrateFact(setup.event).find(f => f.type === Event.Type)!;

        // Assert the specific authorization denial, not just any error, so a
        // setup/engine failure can't masquerade as a passing regression guard.
        const read = setup.authorization.read(subscriberIdentity, [eventRef], finalistsOfEvent);
        await expect(read).rejects.toThrow(Forbidden);
        await expect(read).rejects.toThrow(/Cannot distribute/);
    });
});

async function givenAuthorization(subscriberIsAdmin: boolean) {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();

    const subscriberFact = await keystore.getOrCreateUserFact(subscriberIdentity);
    const creatorFact = await keystore.getOrCreateUserFact(creatorIdentity);
    const subscriber = new User(subscriberFact.fields.publicKey);
    const creator = new User(creatorFact.fields.publicKey);

    const tenant = new Tenant(creator);
    const event = new Event(tenant, "event-id");
    const competitor = new Competitor(tenant);
    const finalist = new Finalist(competitor, event);

    const facts = [
        ...dehydrateFact(subscriber),
        ...dehydrateFact(creator),
        ...dehydrateFact(event),
        ...dehydrateFact(competitor),
        ...dehydrateFact(finalist)
    ];
    if (subscriberIsAdmin) {
        const administrator = new Administrator(tenant, subscriber, new Date("2024-01-01"));
        facts.push(...dehydrateFact(administrator));
    }

    // Dedupe by hash+type to avoid double-saving shared predecessors.
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
        .any(Tenant)
        .any(Administrator)
        .any(Event)
        .any(Competitor)
        .any(Finalist)
        .any(CompetitorName);

    const distributionRules = new DistributionRules([])
        .share(model.given(Event).select((event, facts) => ({
            // Finalist is only a traversal step toward the competitor projection.
            finalists: facts.ofType(Finalist)
                .join(finalist => finalist.event, event)
                .selectMany(finalist => finalist.competitor.predecessor()
                    .select(competitor => ({
                        competitorNames: facts.ofType(CompetitorName)
                            .join(name => name.competitor, competitor)
                            .notExists(name => facts.ofType(CompetitorName)
                                .join(next => next.prior, name)
                            )
                    }))
                )
        })))
        .with(model.given(Event).match((event, facts) =>
            facts.ofType(Administrator)
                .join(a => a.tenant, event.tenant)
                .selectMany(a => facts.ofType(User).join(u => u, a.user))
        ));

    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, distributionRules);
    return { authorization, event };
}
