import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactEnvelope,
    FactManager,
    FeedCache,
    Forbidden,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// Issue #224. `/save` authorizes a whole request as one batch before saving
// any of it. Before jinaga 6.16.0 a rule's tail read the store alone, so an
// Answer authorized through an Attendee in the same request was refused, while
// the same two facts sent as two requests were accepted. The model is the one
// in jinaga/jinaga.js#396's *Demonstrated* section.

class Tenant {
    static Type = "BatchAuth.Tenant" as const;
    public type = Tenant.Type;
    constructor(public creator: User) { }
}

class Attendee {
    static Type = "BatchAuth.Attendee" as const;
    public type = Attendee.Type;
    constructor(public user: User, public tenant: Tenant) { }
}

class Answer {
    static Type = "BatchAuth.Answer" as const;
    public type = Answer.Type;
    constructor(public tenant: Tenant, public author: User, public value: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Tenant, x => x.predecessor("creator", User))
    .type(Attendee, x => x
        .predecessor("user", User)
        .predecessor("tenant", Tenant))
    .type(Answer, x => x
        .predecessor("tenant", Tenant)
        .predecessor("author", User))
);

// Answer is authorized for the user of every Attendee of its tenant: a
// successor walk from the tenant, so the rule's tail has to find the Attendee.
const authorizationRules = (a: AuthorizationRules) => a
    .any(User)
    .type(Tenant, t => t.creator)
    .type(Attendee, att => att.user)
    .type(Answer, (ans, facts) => facts.ofType(Attendee)
        .join(att => att.tenant, ans.tenant)
        .selectMany(att => facts.ofType(User)
            .join(u => u, att.user)));

const organizerIdentity = { provider: "mock", id: "organizer" };
const attendeeIdentity = { provider: "mock", id: "attendee" };

function requestUserOf(identity: { provider: string, id: string }): RequestUser {
    return { provider: identity.provider, id: identity.id, profile: {} as any };
}

async function createHarness() {
    const store = new MemoryStore();
    const keystore = new MemoryKeystore();
    const organizerFact = await keystore.getOrCreateUserFact(organizerIdentity);
    const attendeeFact = await keystore.getOrCreateUserFact(attendeeIdentity);
    const organizer = new User(organizerFact.fields.publicKey);
    const attendee = new User(attendeeFact.fields.publicKey);

    const factManager = new FactManager(
        new PassThroughFork(store), new ObservableSource(store), store, new NetworkNoOp(), []);
    const authorization = new AuthorizationKeystore(
        factManager, store, keystore,
        authorizationRules(new AuthorizationRules(model)),
        new DistributionRules([]));
    const router = new HttpRouter(factManager, authorization, new FeedCache(), "*");

    return { store, router, organizer, attendee };
}

function envelopesOf(...facts: object[]): FactEnvelope[] {
    const records = facts.flatMap(f => dehydrateFact(f as any));
    const unique = records.filter((r, i) =>
        records.findIndex(o => o.type === r.type && o.hash === r.hash) === i);
    return unique.map(fact => ({ fact, signatures: [] }));
}

function graphSourceOf(envelopes: FactEnvelope[]) {
    return {
        read: async (onEnvelopes: (envelopes: FactEnvelope[]) => Promise<void>) => {
            await onEnvelopes(envelopes);
        }
    };
}

function referenceOf(fact: object) {
    const records = dehydrateFact(fact as any);
    const last = records[records.length - 1];
    return { type: last.type, hash: last.hash };
}

async function save(router: HttpRouter, identity: { provider: string, id: string }, envelopes: FactEnvelope[]) {
    return (router as any).save(requestUserOf(identity), graphSourceOf(envelopes));
}

describe("POST /save with a fact authorized by another fact in the same request", () => {
    it("accepts an Answer authorized by an Attendee in the same request", async () => {
        const { store, router, organizer, attendee } = await createHarness();
        const tenant = new Tenant(organizer);
        await save(router, organizerIdentity, envelopesOf(tenant));

        const attendance = new Attendee(attendee, tenant);
        const answer = new Answer(tenant, attendee, "yes");
        await expect(save(router, attendeeIdentity, envelopesOf(attendance, answer)))
            .resolves.toBeUndefined();

        const saved = await store.whichExist([referenceOf(attendance), referenceOf(answer)]);
        expect(saved.map(r => r.type).sort()).toEqual([Answer.Type, Attendee.Type].sort());
    });

    it("still refuses an Answer that nothing in the store or the request authorizes", async () => {
        const { store, router, organizer, attendee } = await createHarness();
        const tenant = new Tenant(organizer);
        await save(router, organizerIdentity, envelopesOf(tenant));

        const answer = new Answer(tenant, attendee, "yes");
        const error = await save(router, attendeeIdentity, envelopesOf(answer))
            .then(() => undefined, (e: unknown) => e);

        // `handleError` maps Forbidden to 403 with the message as the body.
        expect(error).toBeInstanceOf(Forbidden);
        expect((error as Error).message).toBe(`Rejected 1 fact of type ${Answer.Type}.`);
        expect(await store.whichExist([referenceOf(answer)])).toEqual([]);
    });
});
