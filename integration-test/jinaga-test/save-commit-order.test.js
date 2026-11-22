const { Pool } = require('pg');
const { buildModel, dehydrateFact, User } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');

// Issue #203. A save takes its fact ids in commit order.
//
// `fact.fact_id` is a SERIAL, assigned when a save inserts rather than when it
// commits, and a feed tuple's position is its fact ids. Two saves at
// READ COMMITTED could therefore commit out of id order, and the fact holding
// the lower id would land behind a bookmark a reader had already passed. It
// would never be delivered to that reader again.
//
// Each test here holds one save open after its fact insert and runs a second
// save against it. The hold is fixed by which statement the hook waits on, not
// by any interval, so each test takes the same path on every run. This is the
// instrument `read-snapshot.test.js` uses, for the same reason: the test user
// is NOSUPERUSER and holds only SELECT, INSERT and DELETE on `public.fact`
// (`integration-test/postgres/2-grant.sh`), so it can install no trigger.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
    connectionString
});

// Every held transaction is released and awaited after each test, so that a
// failing assertion cannot strand an open transaction and its pooled client.
let gates = [];
let saves = [];

afterEach(async () => {
    gates.forEach(release => release());
    gates = [];
    await Promise.allSettled(saves);
    saves = [];
});

afterAll(async () => {
    await pool.end();
});

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const tenantType = `SCO${suffix}.Tenant`;
const answerType = `SCO${suffix}.Answer`;

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

const model = buildModel(b => b
    .type(User)
    .type(Tenant, m => m.predecessor("creator", User))
    .type(Answer, m => m.predecessor("tenant", Tenant))
);

// One label, so a tuple's position is the answer's own fact id.
const answersFeed = model.given(Tenant).match((tenant, facts) =>
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

function isFactInsert(text) {
    return text.includes('INSERT INTO public.fact (hash, fact_type_id, data)');
}

function isCommit(text) {
    return text.trim() === 'COMMIT';
}

// A pool whose clients call `before` with each statement's text just before
// running it. `before` may await, which holds the transaction open, or throw,
// which fails it.
function hookedPool(before) {
    return {
        connect: async () => {
            const client = await pool.connect();
            const query = client.query;
            const release = client.release;
            client.query = async function (text, ...rest) {
                if (typeof text === 'string') {
                    await before(text);
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
}

// Start a save that stops just before its COMMIT, so it has inserted its fact
// and taken its id but has not committed. Returns the save, a flag that says
// when it is holding, and the function that lets it commit.
function startHeldSave(envelopes) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = { holding: false };
    const wrapped = hookedPool(async text => {
        if (isCommit(text)) {
            state.holding = true;
            await gate;
        }
    });
    gates.push(release);
    const save = new PostgresStore(wrapped, 'public').save(envelopes);
    saves.push(save);
    return { save, state, release };
}

function track(save) {
    saves.push(save);
    return save;
}

async function untilHolding(state) {
    while (!state.holding) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

// Resolves to "settled" if `promise` settles within `ms`, else "pending".
function within(promise, ms) {
    let timer;
    const settled = promise.then(() => "settled", () => "settled");
    return Promise.race([
        settled,
        new Promise(resolve => { timer = setTimeout(() => resolve("pending"), ms); })
    ]).finally(() => clearTimeout(timer));
}

// The number of backends waiting for an advisory lock. `PostgresStore.save`
// holds the only advisory lock this codebase takes, so on a build without it
// this is always zero and the wait below can only end by the save finishing.
async function advisoryWaiters() {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS waiting
         FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`);
    return rows[0].waiting;
}

// Wait until `save` has either finished or parked waiting for the save lock,
// and say which. Neither branch is a timeout, so the phase that follows starts
// from a known state on both builds: without the lock a save can only finish,
// and with it a save contending for a held lock can only park.
async function settledOrBlocked(save) {
    let settled = false;
    const mark = () => { settled = true; };
    save.then(mark, mark);
    for (;;) {
        // Give the save a turn, then look, so a save that finishes without
        // ever contending is seen as settled rather than as blocked.
        await new Promise(resolve => setImmediate(resolve));
        if (settled) {
            return "settled";
        }
        if (await advisoryWaiters() > 0) {
            return "blocked";
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function factIdOf(reference) {
    const { rows } = await pool.query(
        `SELECT f.fact_id
         FROM public.fact f
         JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id
         WHERE f.hash = $1 AND t.name = $2`,
        [reference.hash, reference.type]);
    return rows.length > 0 ? rows[0].fact_id : null;
}

// Page the feed from `bookmark` until it yields nothing, keeping the bookmark
// across pages the way a client with durable storage does.
async function drain(store, start, bookmark) {
    const hashes = [];
    for (;;) {
        const feed = await store.feed(answersFeed, start, bookmark);
        if (feed.tuples.length === 0) {
            return { hashes, bookmark };
        }
        for (const tuple of feed.tuples) {
            hashes.push(tuple.facts[tuple.facts.length - 1].hash);
        }
        bookmark = feed.bookmark;
    }
}

describe("PostgresStore save assigns fact ids in commit order", () => {
    const writer = new PostgresStore(pool, 'public');
    let tenant, start;

    beforeEach(async () => {
        const id = Math.random().toString(36).slice(2, 10);
        const user = new User(`PUBLIC KEY ${suffix} ${id}`);
        tenant = new Tenant(user, id);
        start = [referenceOf(tenant)];
        // One answer exists first, so the types and roles the later saves need
        // are already known and the reader starts from a real bookmark.
        await writer.save(envelopesOf(new Answer(tenant, "seed")));
    });

    // Criterion 1.
    it("gives the second of two concurrent saves the higher fact id", async () => {
        const first = new Answer(tenant, "first");
        const second = new Answer(tenant, "second");

        const held = startHeldSave(envelopesOf(first));
        await untilHolding(held.state);

        // The second save cannot take an id while the first one holds its own,
        // so it parks on the lock rather than running to completion. On main
        // there is no lock to park on and this reads "settled".
        const secondSave = track(writer.save(envelopesOf(second)));
        expect(await settledOrBlocked(secondSave)).toBe("blocked");

        held.release();
        await held.save;
        await secondSave;

        const firstId = await factIdOf(referenceOf(first));
        const secondId = await factIdOf(referenceOf(second));
        expect(firstId).not.toBeNull();
        expect(secondId).not.toBeNull();
        expect(secondId).toBeGreaterThan(firstId);
    });

    // Criterion 2. This is the one that fails on main: there the second save
    // commits first, the reader's bookmark passes the first save's lower id,
    // and the first fact is never delivered to that reader.
    it("delivers both facts to a reader that keeps its bookmark across the commits", async () => {
        const first = new Answer(tenant, "first");
        const second = new Answer(tenant, "second");

        let { bookmark } = await drain(writer, start, "");

        const held = startHeldSave(envelopesOf(first));
        await untilHolding(held.state);
        const secondSave = track(writer.save(envelopesOf(second)));

        // Do not read until the second save has gone as far as it can. On main
        // that is a commit, which is the interleaving this criterion is about:
        // reading before it would let the reader see nothing, keep the seed
        // bookmark, and then receive both facts after the release, passing for
        // the wrong reason. On this branch it is parked on the lock instead.
        await settledOrBlocked(secondSave);

        // Read between the commits, keeping the bookmark.
        const between = await drain(writer, start, bookmark);
        bookmark = between.bookmark;

        held.release();
        await held.save;
        await secondSave;

        // Read again from the bookmark the reader kept.
        const after = await drain(writer, start, bookmark);

        const received = [...between.hashes, ...after.hashes];
        expect(received).toContain(referenceOf(first).hash);
        expect(received).toContain(referenceOf(second).hash);
    });

    // Criterion 3.
    it("lets the next save proceed after one rolls back", async () => {
        let thrown = false;
        const failing = hookedPool(async text => {
            if (isFactInsert(text) && !thrown) {
                thrown = true;
                throw new Error("insert failed for the test");
            }
        });

        await expect(new PostgresStore(failing, 'public')
            .save(envelopesOf(new Answer(tenant, "rolled back"))))
            .rejects.toThrow("insert failed for the test");
        expect(thrown).toBe(true);

        // The lock is transaction-scoped, so the rollback released it.
        const next = new Answer(tenant, "after the rollback");
        expect(await within(track(writer.save(envelopesOf(next))), 5000)).toBe("settled");
        expect(await factIdOf(referenceOf(next))).not.toBeNull();
    });
});
