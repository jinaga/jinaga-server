const { Pool } = require('pg');
const { buildModel, dehydrateFact, User } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');

// Issue #226, part B. One read sees one graph.
//
// Each test wraps the pool the store under test reads through, so that just
// before one chosen statement of `read` runs, a write commits on another
// connection and only then does that statement run. The interleaving is fixed
// by which statement the hook waits on, not by any interval, so each test
// takes the same path on every run.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
    connectionString
});

afterAll(async () => {
    await pool.end();
});

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const tenantType = `RSNP${suffix}.Tenant`;
const answerType = `RSNP${suffix}.Answer`;
const commentType = `RSNP${suffix}.Comment`;

class Tenant {
    constructor(creator, identifier) {
        this.type = tenantType;
        this.creator = creator;
        this.identifier = identifier;
    }
}
Tenant.Type = tenantType;

class Answer {
    constructor(tenant, text) {
        this.type = answerType;
        this.tenant = tenant;
        this.text = text;
    }
}
Answer.Type = answerType;

class Comment {
    constructor(answer, text) {
        this.type = commentType;
        this.answer = answer;
        this.text = text;
    }
}
Comment.Type = commentType;

const model = buildModel(b => b
    .type(User)
    .type(Tenant, m => m.predecessor("creator", User))
    .type(Answer, m => m.predecessor("tenant", Tenant))
    .type(Comment, m => m.predecessor("answer", Answer))
);

// A parent query for the answers, and a child query for their comments.
const answersWithComments = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Answer)
        .join(answer => answer.tenant, tenant)
        .select(answer => ({
            text: answer.text,
            comments: facts.ofType(Comment)
                .join(comment => comment.answer, answer)
                .select(comment => comment.text)
        }))
).specification;

// The answers themselves, so that `read` loads them after the query tree.
const answerFacts = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Answer)
        .join(answer => answer.tenant, tenant)
).specification;

function envelopesOf(fact) {
    return dehydrateFact(fact).map(record => ({ fact: record, signatures: [] }));
}

function referenceOf(fact) {
    const records = dehydrateFact(fact);
    const record = records[records.length - 1];
    return { type: record.type, hash: record.hash };
}

function isResultQuery(text) {
    return text.startsWith('SELECT f1.hash as hash1');
}

function isLoadQuery(text) {
    return text.includes('JOIN public.ancestor a');
}

// A pool whose clients run `action` once, to completion, just before the
// `occurrence`th statement for which `matches` is true.
function interleavedPool(matches, occurrence, action) {
    let seen = 0;
    const state = { fired: false };
    const wrapped = {
        connect: async () => {
            const client = await pool.connect();
            const query = client.query;
            const release = client.release;
            client.query = async function (text, ...rest) {
                if (typeof text === 'string' && matches(text) && ++seen === occurrence) {
                    state.fired = true;
                    await action();
                }
                return query.call(client, text, ...rest);
            };
            client.release = function (...args) {
                // Restore the pooled client before it goes back to the pool.
                delete client.query;
                delete client.release;
                return release.call(client, ...args);
            };
            return client;
        }
    };
    return { pool: wrapped, state };
}

function textsOf(results) {
    return results
        .map(r => ({ text: r.result.text, comments: r.result.comments.map(c => c.result).sort() }))
        .sort((a, b) => a.text.localeCompare(b.text));
}

describe("PostgresStore read sees one graph", () => {
    const writer = new PostgresStore(pool, 'public');
    let user, tenant, first, second;

    beforeEach(async () => {
        const id = Math.random().toString(36).slice(2, 10);
        user = new User(`PUBLIC KEY ${suffix} ${id}`);
        tenant = new Tenant(user, id);
        first = new Answer(tenant, "first");
        second = new Answer(tenant, "second");
        // One comment exists before the read, so the comment type and its
        // role are known to the read's snapshot and its child query runs.
        await writer.save([
            ...envelopesOf(first),
            ...envelopesOf(second),
            ...envelopesOf(new Comment(second, "before"))
        ]);
    });

    it("does not show a child saved between the parent query and the child query", async () => {
        const { pool: interleaved, state } = interleavedPool(isResultQuery, 2, async () => {
            await writer.save(envelopesOf(new Comment(first, "during")));
        });
        const store = new PostgresStore(interleaved, 'public');

        const results = await store.read([referenceOf(tenant)], answersWithComments);

        expect(state.fired).toBe(true);
        expect(textsOf(results)).toEqual([
            { text: "first", comments: [] },
            { text: "second", comments: [ "before" ] }
        ]);

        // The save did land: the next read sees it.
        const afterwards = await writer.read([referenceOf(tenant)], answersWithComments);
        expect(textsOf(afterwards)).toEqual([
            { text: "first", comments: [ "during" ] },
            { text: "second", comments: [ "before" ] }
        ]);
    });

    it("loads the same facts when a save lands between the query tree and the load", async () => {
        const { pool: interleaved, state } = interleavedPool(isLoadQuery, 1, async () => {
            await writer.save(envelopesOf(new Answer(tenant, "during")));
        });
        const store = new PostgresStore(interleaved, 'public');

        const results = await store.read([referenceOf(tenant)], answerFacts);

        expect(state.fired).toBe(true);
        expect(results.map(r => r.result.text).sort()).toEqual([ "first", "second" ]);

        const afterwards = await writer.read([referenceOf(tenant)], answerFacts);
        expect(afterwards.map(r => r.result.text).sort()).toEqual([ "during", "first", "second" ]);
    });

    // A save only adds facts, and the facts a load reads by reference never
    // change, so the case above cannot tell one snapshot from two. A purge
    // removes facts, so this one can: a load in its own snapshot misses a
    // fact the query tree found.
    it("loads the facts the query tree found when a purge lands between them", async () => {
        const { pool: interleaved, state } = interleavedPool(isLoadQuery, 1, async () => {
            await writer.purgeDescendants(referenceOf(tenant), [ referenceOf(second) ]);
        });
        const store = new PostgresStore(interleaved, 'public');

        const results = await store.read([referenceOf(tenant)], answerFacts);

        expect(state.fired).toBe(true);
        expect(results.map(r => r.result && r.result.text).sort()).toEqual([ "first", "second" ]);

        const afterwards = await writer.read([referenceOf(tenant)], answerFacts);
        expect(afterwards.map(r => r.result.text)).toEqual([ "second" ]);
    });
});
