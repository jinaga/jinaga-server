const request = require('supertest');
const { Pool } = require('pg');
const { buildModel, dehydrateFact, User } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');
const { connectionString, createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Issue #224, criteria 2 and 5, through PostgresStore. `/save` authorizes the
// whole request as one batch. An Answer authorized for the user of every
// Attendee of its tenant is accepted when its Attendee arrives in the same
// request, and refused, with a 403 naming it, when nothing authorizes it.
// The model is the one in jinaga/jinaga.js#396's *Demonstrated* section.

const suffix = randomSuffix();

class Tenant {
    static Type = `BatchSave${suffix}.Tenant`;
    type = Tenant.Type;
    constructor(creator, identifier) {
        this.creator = creator;
        this.identifier = identifier;
    }
}

class Attendee {
    static Type = `BatchSave${suffix}.Attendee`;
    type = Attendee.Type;
    constructor(user, tenant) {
        this.user = user;
        this.tenant = tenant;
    }
}

class Answer {
    static Type = `BatchSave${suffix}.Answer`;
    type = Answer.Type;
    constructor(tenant, author, value) {
        this.tenant = tenant;
        this.author = author;
        this.value = value;
    }
}

const model = buildModel(b => b
    .type(User)
    .type(Tenant, m => m.predecessor("creator", User))
    .type(Attendee, m => m
        .predecessor("user", User)
        .predecessor("tenant", Tenant))
    .type(Answer, m => m
        .predecessor("tenant", Tenant)
        .predecessor("author", User))
);

function authorization(a) {
    return a
        .any(User)
        .type(Tenant, t => t.creator)
        .type(Attendee, att => att.user)
        .type(Answer, (ans, facts) => facts.ofType(Attendee)
            .join(att => att.tenant, ans.tenant)
            .selectMany(att => facts.ofType(User)
                .join(u => u, att.user)));
}

function recordsOf(...facts) {
    const records = facts.flatMap(f => dehydrateFact(f));
    return records.filter((r, i) =>
        records.findIndex(o => o.type === r.type && o.hash === r.hash) === i);
}

function referenceOf(fact) {
    const records = dehydrateFact(fact);
    const last = records[records.length - 1];
    return { type: last.type, hash: last.hash };
}

function save(app, userId, facts) {
    return request(app)
        .post('/save')
        .set('x-test-user-id', userId)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ facts: recordsOf(...facts) }));
}

jest.setTimeout(30000);

describe('POST /save through PostgresStore with a fact authorized by another in the same request', () => {
    let app, withSession, close, organizer, attendee, pool, store;

    beforeAll(async () => {
        ({ app, withSession, close } = await createSubscriptionApp({
            model,
            authorization
        }));
        organizer = await asUser(withSession, `organizer-${suffix}`, async j => (await j.login()).userFact);
        attendee = await asUser(withSession, `attendee-${suffix}`, async j => (await j.login()).userFact);
        // A store of the test's own, to read what the server committed.
        pool = new Pool({ connectionString });
        store = new PostgresStore(pool, 'public');
    });

    afterAll(async () => {
        await close();
        await pool.end();
    });

    async function exists(fact) {
        const found = await store.whichExist([referenceOf(fact)]);
        return found.length === 1;
    }

    it('accepts an Answer and its Attendee in one request', async () => {
        const tenant = new Tenant(organizer, 'accepted');
        await save(app, `organizer-${suffix}`, [tenant]).expect(201);

        const attendance = new Attendee(attendee, tenant);
        const answer = new Answer(tenant, attendee, 'yes');
        await save(app, `attendee-${suffix}`, [attendance, answer]).expect(201);

        expect(await exists(attendance)).toBe(true);
        expect(await exists(answer)).toBe(true);
    });

    it('refuses an Answer nothing authorizes with a 403 naming it', async () => {
        // A tenant of its own, so the Attendee the first test saved is no witness.
        const tenant = new Tenant(organizer, 'refused');
        await save(app, `organizer-${suffix}`, [tenant]).expect(201);

        const answer = new Answer(tenant, attendee, 'no');
        const response = await save(app, `attendee-${suffix}`, [answer]);

        expect(response.status).toBe(403);
        expect(response.text).toBe(`Rejected 1 fact of type ${Answer.Type}.`);
        expect(await exists(answer)).toBe(false);
    });
});
