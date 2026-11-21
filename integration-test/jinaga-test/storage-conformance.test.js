const { Pool } = require('pg');
const { describeStorageConformance } = require('jinaga/conformance');
const { PostgresStore } = require('./jinaga-server');

// jinaga exports its storage conformance suite from `jinaga/conformance`.
// PostgresStore has to answer all of it as MemoryStore does: issue #226,
// criterion 4.
//
// The suite saves its fixture before each test. Every save of it after the
// first finds the facts already stored, so each test sees the same graph.

const connectionString = 'postgresql://dev:devpw@db:5432/integrationtest';
const pool = new Pool({ connectionString });

afterAll(async () => {
    await pool.end();
});

describeStorageConformance('PostgresStore', () => new PostgresStore(pool, 'public'));
