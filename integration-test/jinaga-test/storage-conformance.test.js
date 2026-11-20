const { Pool } = require('pg');
const { describeStorageConformance } = require('jinaga/conformance');
const { PostgresStore } = require('./jinaga-server');

// jinaga exports its storage conformance suite from `jinaga/conformance`.
// PostgresStore has to answer it as MemoryStore does.
//
// Every case is registered but one. jinaga 6.16.0's interleaving case requires
// the graph as it stood at the instant of the read, which no store that
// acquires a pooled connection before its first statement can give, and which
// correctness does not require. jinaga/jinaga.js#424 corrects it, renaming it
// as it does. Issue #226, criterion 4, registers the whole suite once the
// `jinaga` release carrying that correction is taken. When the release is
// taken, the old title is gone and this file throws, so the exclusion cannot
// outlive its reason.
//
// The suite saves its fixture before each test. Every save of it after the
// first finds the facts already stored, so each test sees the same graph.

const EXCLUDED = 'should return the graph as it stood when the read began, while a save lands during the read';

const connectionString = 'postgresql://dev:devpw@db:5432/integrationtest';
const pool = new Pool({ connectionString });

afterAll(async () => {
    await pool.end();
});

function describeConformanceExcept(excluded, name, createStore) {
    const realIt = global.it;
    let found = false;
    global.it = (title, fn, timeout) => {
        if (title === excluded) {
            found = true;
            return;
        }
        realIt(title, fn, timeout);
    };
    try {
        describeStorageConformance(name, createStore);
    }
    finally {
        global.it = realIt;
    }
    if (!found) {
        throw new Error(`The conformance suite no longer has the case "${excluded}". Register the whole suite (issue #226, criterion 4).`);
    }
}

describeConformanceExcept(EXCLUDED, 'PostgresStore', () => new PostgresStore(pool, 'public'));
