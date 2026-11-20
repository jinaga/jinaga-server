const { Pool } = require('pg');
const { describeStorageConformance } = require('jinaga/conformance');
const { PostgresStore } = require('./jinaga-server');

// Issue #224, criterion 7. jinaga exports its storage conformance suite from
// `jinaga/conformance`, and the cases jinaga/jinaga.js#396 adds sit in its
// `readAsIfSaved` section. PostgresStore has to answer them as MemoryStore
// does.
//
// Only that section is registered here. The suite's `read` section also has
// cases PostgresStore does not pass today, none of them about readAsIfSaved:
// a specification with no matches, which `read` answers with no rows, and a
// save landing between the type lookups `read` makes and its query. They are
// recorded on #225 rather than hidden. Registering them here would put
// failures this issue does not own into this criterion.
//
// The suite saves its fixture before each test. Every save of it after the
// first finds the facts already stored, so each test sees the same graph.

const connectionString = 'postgresql://dev:devpw@db:5432/integrationtest';
const pool = new Pool({ connectionString });

afterAll(async () => {
    await pool.end();
});

// Register the suite with `it` live only inside its `readAsIfSaved` section.
// Its hooks are registered as written, so each case still gets a fresh fixture.
function describeReadAsIfSavedConformance(name, createStore) {
    const realDescribe = global.describe;
    const realIt = global.it;
    let depth = 0;
    let registered = 0;
    global.describe = (title, body) => realDescribe(title, () => {
        const inside = title === 'readAsIfSaved';
        if (inside) depth++;
        try {
            body();
        }
        finally {
            if (inside) depth--;
        }
    });
    global.it = (title, fn, timeout) => {
        if (depth > 0) {
            registered++;
            realIt(title, fn, timeout);
        }
    };
    try {
        describeStorageConformance(name, createStore);
    }
    finally {
        global.describe = realDescribe;
        global.it = realIt;
    }
    // If the section were renamed nothing would register, and this file would
    // pass by asserting nothing.
    if (registered === 0) {
        throw new Error('The conformance suite has no readAsIfSaved section to register.');
    }
}

describeReadAsIfSavedConformance('PostgresStore', () => new PostgresStore(pool, 'public'));

