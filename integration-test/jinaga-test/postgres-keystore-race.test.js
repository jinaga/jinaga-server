const { Pool } = require('pg');
const { PostgresKeystore } = require('jinaga-server');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
    connectionString
});

describe('PostgresKeystore concurrency race', () => {
    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        // Ensure no row exists yet for the test identities so the
        // select-then-insert path is exercised from a clean state.
        await pool.query(`DELETE FROM public."user" WHERE provider = 'test-provider'`);
    });

    it('should not fail when two concurrent requests create the same user key pair', async () => {
        const userIdentity = { provider: 'test-provider', id: 'race-user-1' };

        // Two separate keystore instances model two concurrent requests that
        // each build a fresh runtime (empty in-process cache), as described in
        // issue #177. Both SELECT zero rows and race to INSERT.
        const keystoreA = new PostgresKeystore(pool, 'public');
        const keystoreB = new PostgresKeystore(pool, 'public');

        const [factA, factB] = await Promise.all([
            keystoreA.getOrCreateUserFact(userIdentity),
            keystoreB.getOrCreateUserFact(userIdentity)
        ]);

        // Both requests succeed and observe the same public key (the winner's).
        expect(factA.type).toBe('Jinaga.User');
        expect(factB.type).toBe('Jinaga.User');
        expect(factA.fields.publicKey).toBe(factB.fields.publicKey);
        expect(factA.hash).toBe(factB.hash);

        // Exactly one row was persisted for the identity.
        const { rows } = await pool.query(
            `SELECT public_key FROM public."user" WHERE provider = $1 AND user_identifier = $2`,
            [userIdentity.provider, userIdentity.id]);
        expect(rows.length).toBe(1);
        expect(rows[0].public_key).toBe(factA.fields.publicKey);
    });

    it('should tolerate many concurrent creations of the same identity', async () => {
        const userIdentity = { provider: 'test-provider', id: 'race-user-2' };

        // A larger fan-out of fresh runtimes all racing on the same identity.
        const keystores = Array.from({ length: 8 }, () => new PostgresKeystore(pool, 'public'));

        const facts = await Promise.all(
            keystores.map(keystore => keystore.getOrCreateUserFact(userIdentity)));

        // Every caller resolves to the same key pair.
        const publicKeys = new Set(facts.map(fact => fact.fields.publicKey));
        expect(publicKeys.size).toBe(1);

        const { rows } = await pool.query(
            `SELECT public_key FROM public."user" WHERE provider = $1 AND user_identifier = $2`,
            [userIdentity.provider, userIdentity.id]);
        expect(rows.length).toBe(1);
    });
});
