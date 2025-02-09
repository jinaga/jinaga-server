const { Pool } = require('pg');
const { PostgresStore } = require('jinaga-server');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
    connectionString
});

describe('PostgresStore duplicate handling', () => {
    let store;

    beforeAll(async () => {
        store = new PostgresStore(pool, 'public');
    });

    afterAll(async () => {
        await pool.end();
    });

    it('should handle duplicate facts in same batch', async () => {
        // Create two identical facts
        const fact = {
            type: 'TestType',
            hash: 'duplicate-hash-1',
            fields: { value: 42 },
            predecessors: {}
        };

        const envelopes = [
            { fact, signatures: [] },
            { fact, signatures: [] }  // Same fact
        ];

        // This should not throw, as the second fact should be recognized as duplicate
        const result = await store.save(envelopes);
        
        // Should only return one envelope since the other was a duplicate
        expect(result.length).toBe(1);
        expect(result[0].fact.hash).toBe('duplicate-hash-1');
    });

    it('should handle concurrent saves of same fact', async () => {
        const fact = {
            type: 'TestType',
            hash: 'duplicate-hash-2',
            fields: { value: 42 },
            predecessors: {}
        };

        const envelope = { fact, signatures: [] };

        // Save the same fact concurrently
        const results = await Promise.all([
            store.save([envelope]),
            store.save([envelope])
        ]);

        // Both saves should complete successfully
        expect(results.length).toBe(2);
        
        // One save should return the envelope (first writer wins)
        // and one should return empty array (duplicate detected)
        const totalEnvelopes = results[0].length + results[1].length;
        expect(totalEnvelopes).toBe(1);

        // Verify the fact exists
        const references = [{ type: fact.type, hash: fact.hash }];
        const existing = await store.whichExist(references);
        expect(existing.length).toBe(1);
        expect(existing[0].hash).toBe(fact.hash);
    });

    it('should handle multiple concurrent saves with mixed duplicates', async () => {
        const facts = [
            {
                type: 'TestType',
                hash: 'unique-hash-1',
                fields: { value: 1 },
                predecessors: {}
            },
            {
                type: 'TestType',
                hash: 'duplicate-hash-3',
                fields: { value: 2 },
                predecessors: {}
            },
            {
                type: 'TestType',
                hash: 'unique-hash-2',
                fields: { value: 3 },
                predecessors: {}
            }
        ];

        const batch1 = [
            { fact: facts[0], signatures: [] },
            { fact: facts[1], signatures: [] }
        ];

        const batch2 = [
            { fact: facts[1], signatures: [] },  // Duplicate of batch1[1]
            { fact: facts[2], signatures: [] }
        ];

        // Save both batches concurrently
        const results = await Promise.all([
            store.save(batch1),
            store.save(batch2)
        ]);

        // Both saves should complete successfully
        expect(results.length).toBe(2);

        // Verify all unique facts were saved
        const references = facts.map(f => ({ type: f.type, hash: f.hash }));
        const existing = await store.whichExist(references);
        expect(existing.length).toBe(3);  // All 3 unique facts should exist

        // The duplicate fact should only appear once in the results
        const totalDuplicates = results.flat().filter(e => 
            e.fact.hash === 'duplicate-hash-3'
        ).length;
        expect(totalDuplicates).toBe(1);
    });
});
