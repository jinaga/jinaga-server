const { Pool } = require('pg');
const { buildModel, dehydrateFact, User } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
    connectionString
});

// Each run uses its own type names, so the assertions that a staged fact type
// or role is absent from the database are about this run's rows and not about
// whatever a sibling test left behind.
const suffix = Math.random().toString(36).slice(2, 10);
const tenantType = `RAIS${suffix}.Tenant`;
const answerType = `RAIS${suffix}.Answer`;

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

const answersOfTenant = model.given(Tenant).match((tenant, facts) =>
    facts.ofType(Answer)
        .join(answer => answer.tenant, tenant)
        .select(answer => ({
            text: answer.text
        }))
).specification;

function envelopesOf(fact) {
    return dehydrateFact(fact).map(record => ({ fact: record, signatures: [] }));
}

function referenceOf(records, type) {
    const record = records.find(r => r.fact.type === type);
    return { type: record.fact.type, hash: record.fact.hash };
}

// Counts the rows this run's staged facts would have added, so criterion 3 can
// be checked against the database rather than against the method's own report.
async function countStagedRows(answerReference) {
    const factTypes = await pool.query(
        'SELECT name FROM public.fact_type WHERE name = ANY($1);',
        [[tenantType, answerType]]);
    const facts = await pool.query(
        'SELECT f.hash FROM public.fact f JOIN public.fact_type t' +
        '  ON t.fact_type_id = f.fact_type_id' +
        ' WHERE t.name = $1 AND f.hash = $2;',
        [answerType, answerReference.hash]);
    const roles = await pool.query(
        'SELECT r.name FROM public.role r JOIN public.fact_type t' +
        '  ON t.fact_type_id = r.defining_fact_type_id' +
        ' WHERE t.name = ANY($1);',
        [[tenantType, answerType]]);
    const edges = await pool.query(
        'SELECT e.successor_fact_id FROM public.edge e JOIN public.fact f' +
        '  ON f.fact_id = e.successor_fact_id' +
        ' JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id' +
        ' WHERE t.name = $1;',
        [answerType]);
    const ancestors = await pool.query(
        'SELECT a.fact_id FROM public.ancestor a JOIN public.fact f' +
        '  ON f.fact_id = a.fact_id' +
        ' JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id' +
        ' WHERE t.name = $1;',
        [answerType]);
    return {
        factTypeNames: factTypes.rows.map(r => r.name).sort(),
        answerFacts: facts.rows.length,
        roleNames: roles.rows.map(r => r.name).sort(),
        answerEdges: edges.rows.length,
        answerAncestors: ancestors.rows.length
    };
}

function snapshotCaches(store) {
    return {
        factTypes: [...store.factTypeMap.entries()]
            .map(([name, id]) => `${name}=${id}`).sort(),
        roles: [...store.roleMap.entries()]
            .flatMap(([typeId, roles]) => [...roles.entries()]
                .map(([name, id]) => `${typeId}.${name}=${id}`)).sort()
    };
}

const linkedType = `RAIS${suffix}.Linked`;

describe('PostgresStore.readAsIfSaved', () => {
    let store;
    let tenantReference;
    let answerReference;
    let answerEnvelopes;

    beforeAll(async () => {
        store = new PostgresStore(pool, 'public');

        const creator = new User(`---RAIS ${suffix}---`);
        const tenant = new Tenant(creator, `tenant-${suffix}`);
        const answer = new Answer(tenant, 'yes');

        const tenantEnvelopes = envelopesOf(tenant);
        tenantReference = referenceOf(tenantEnvelopes, tenantType);

        // The tenant is committed. The answer is only ever staged.
        await store.save(tenantEnvelopes);

        // Commit one fact of linkedType with a single role, so the store's
        // roleMap holds an inner map for that type. A staged fact of the same
        // type with a new role then has somewhere to leak to.
        await store.save([{
            fact: {
                type: linkedType,
                hash: `linked-committed-${suffix}`,
                fields: {},
                predecessors: { tenant: tenantReference }
            },
            signatures: []
        }]);

        answerEnvelopes = envelopesOf(answer);
        answerReference = referenceOf(answerEnvelopes, answerType);
    });

    afterAll(async () => {
        await pool.end();
    });

    it('reads a staged fact that read does not see', async () => {
        const committed = await store.read([tenantReference], answersOfTenant);
        expect(committed).toEqual([]);

        const staged = await store.readAsIfSaved(
            answerEnvelopes, [tenantReference], answersOfTenant);
        expect(staged.map(r => r.result.text)).toEqual(['yes']);

        // The staged fact stayed staged: a second plain read still sees nothing.
        const after = await store.read([tenantReference], answersOfTenant);
        expect(after).toEqual([]);
    });

    it('leaves no staged row in the database and no new cache entry', async () => {
        const before = await countStagedRows(answerReference);
        const cachesBefore = snapshotCaches(store);

        await store.readAsIfSaved(
            answerEnvelopes, [tenantReference], answersOfTenant);

        expect(await countStagedRows(answerReference)).toEqual(before);
        expect(snapshotCaches(store)).toEqual(cachesBefore);

        // The answer's type and role are the ones the staged read had to insert.
        // If they were already committed, this test would be asserting nothing.
        expect(before.factTypeNames).toEqual([tenantType]);
        expect(before.answerFacts).toBe(0);
        expect(before.answerEdges).toBe(0);
        expect(before.answerAncestors).toBe(0);
    });

    it('leaves no staged row behind when the read throws', async () => {
        const before = await countStagedRows(answerReference);
        const cachesBefore = snapshotCaches(store);

        // role.name is varchar(200), so this fact's role fails to insert. The
        // fact type is inserted before the role, so the throw lands in the
        // window where an uncommitted fact_type id exists and could reach the
        // store's caches.
        const longRole = 'r'.repeat(250);
        const throwingType = `RAIS${suffix}.Throwing`;
        const throwing = {
            fact: {
                type: throwingType,
                hash: 'throwing-hash',
                fields: {},
                predecessors: {
                    [longRole]: tenantReference
                }
            },
            signatures: []
        };

        await expect(store.readAsIfSaved(
            [throwing], [tenantReference], answersOfTenant)).rejects.toThrow();

        expect(await countStagedRows(answerReference)).toEqual(before);
        expect(snapshotCaches(store)).toEqual(cachesBefore);

        // Neither the fact type the staged read inserted nor the fact itself
        // survived the rollback.
        const typeRows = await pool.query(
            'SELECT name FROM public.fact_type WHERE name = $1;', [throwingType]);
        expect(typeRows.rows).toEqual([]);
        const roleRows = await pool.query(
            'SELECT name FROM public.role WHERE name = $1;', [longRole]);
        expect(roleRows.rows).toEqual([]);
    });

    it('leaves no new role on a type whose roles are already cached', async () => {
        const cachesBefore = snapshotCaches(store);

        // Precondition: without a cached role map for this type there is
        // nothing for a shallow copy to leak into, and the test proves nothing.
        const linkedTypeId = store.factTypeMap.get(linkedType);
        expect(linkedTypeId).toBeDefined();
        expect(store.roleMap.get(linkedTypeId).has('tenant')).toBe(true);
        expect(store.roleMap.get(linkedTypeId).has('sibling')).toBe(false);

        // linkedType is already in both caches with a role map of its own.
        // Staging a fact of that type with a role the store has never seen is
        // the one shape a shallow copy of the role map still leaks, because
        // addRole mutates the inner map it finds.
        const staged = {
            fact: {
                type: linkedType,
                hash: `linked-staged-${suffix}`,
                fields: {},
                predecessors: {
                    tenant: tenantReference,
                    sibling: tenantReference
                }
            },
            signatures: []
        };

        await store.readAsIfSaved([staged], [tenantReference], answersOfTenant);

        expect(snapshotCaches(store)).toEqual(cachesBefore);
        expect(store.roleMap.get(linkedTypeId).has('sibling')).toBe(false);

        const roleRows = await pool.query(
            'SELECT r.name FROM public.role r JOIN public.fact_type t' +
            '  ON t.fact_type_id = r.defining_fact_type_id' +
            ' WHERE t.name = $1 AND r.name = $2;',
            [linkedType, 'sibling']);
        expect(roleRows.rows).toEqual([]);
    });

    it('returns the same rows as read when nothing is staged', async () => {
        const committedAnswer = new Answer(
            new Tenant(new User(`---RAIS ${suffix}---`), `tenant-${suffix}`),
            'committed');
        const committedEnvelopes = envelopesOf(committedAnswer);
        await store.save(committedEnvelopes);

        const read = await store.read([tenantReference], answersOfTenant);
        const readAsIfSaved = await store.readAsIfSaved(
            [], [tenantReference], answersOfTenant);

        expect(read.map(r => r.result.text)).toEqual(['committed']);
        expect(readAsIfSaved).toEqual(read);
    });
});
