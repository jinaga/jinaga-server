const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { buildFeeds, dehydrateFact, dehydrateReference, Trace } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');
const { parseSpecification } = require('./test-helpers');

// Issue #256. #206 bounds a feed page by the bookmark's largest fact id, and
// emits one UNION branch per output fact because an inequality OR'd across
// several relations restricts none of them. The bound only has to hold of the
// output carrying the tuple's largest id, though, and where every edge runs
// from a lower fact id to a higher one that is the output no other output sits
// above on a successor path. Running the other branches anyway walks the feed
// a second time and hashes both results to deduplicate, which made a deep page
// of a multi-output feed slower with the bound than without it.
//
// That pruning is sound only while the id order holds. Saves now order each
// batch, setup.sql records the order as the CHECK constraint
// ck_edge_successor_after_predecessor, repair-edge-order.sql restores the
// order of a database written before that, and PostgresStore reads the
// constraint's convalidated flag before it prunes anything.
//
// `sqlFromFeed` is not part of the package's public API, so these tests reach
// the module inside the built package, as the #206 tests do. They are
// measuring generated SQL, which is the thing the issue is about.
const { sqlFromFeed } = require('./jinaga-server/dist/postgres/specification-sql');

jest.setTimeout(600000);

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;
// The repair is maintenance: it renumbers facts and alters constraints, which
// the application role is not granted. It runs as the database's owner.
const adminConnectionString = `postgresql://postgres:superuser@${host}:5432/integrationtest`;

// The schema and the repair script as they are committed, copied beside the
// built package by run.sh. The tests run the real files rather than a copy of
// their statements, so an edit to either shows up here.
const setupSqlPath = path.join(__dirname, 'jinaga-server', 'setup.sql');
const repairSqlPath = path.join(__dirname, 'jinaga-server', 'repair-edge-order.sql');

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const siteType = `BP${suffix}.Site`;
const postType = `BP${suffix}.Post`;
const titleType = `BP${suffix}.Post.Title`;
const postDeletedType = `BP${suffix}.Post.Deleted`;

function site(domain) {
    return { type: siteType, domain };
}

function post(siteFact, createdAt) {
    return { type: postType, site: siteFact, createdAt };
}

function title(postFact, value, prior) {
    return { type: titleType, post: postFact, value, prior };
}

function postDeleted(postFact) {
    return { type: postDeletedType, post: postFact };
}

function envelopesOf(facts) {
    const records = [];
    for (const fact of facts) {
        for (const record of dehydrateFact(fact)) {
            if (!records.some(r => r.type === record.type && r.hash === record.hash)) {
                records.push(record);
            }
        }
    }
    return records.map(fact => ({ fact, signatures: [] }));
}

const pool = new Pool({ connectionString });
const adminPool = new Pool({ connectionString: adminConnectionString, max: 2 });
let store;

const constraintName = 'ck_edge_successor_after_predecessor';

async function constraintState() {
    const { rows } = await adminPool.query(
        `SELECT convalidated FROM pg_constraint
         WHERE conname = $1 AND conrelid = 'public.edge'::regclass`,
        [constraintName]);
    return rows.length === 0 ? 'absent' : (rows[0].convalidated ? 'validated' : 'unvalidated');
}

async function deferrableForeignKeys() {
    const { rows } = await adminPool.query(
        `SELECT c.conname, c.conrelid::regclass::text AS table_name
         FROM pg_constraint c
         WHERE c.contype = 'f'
           AND c.confrelid = 'public.fact'::regclass
           AND c.condeferrable
         ORDER BY table_name, c.conname`);
    return rows.map(row => `${row.table_name}.${row.conname}`);
}

async function runSqlFile(filePath, withPool) {
    const sql = fs.readFileSync(filePath, 'utf8');
    await (withPool || adminPool).query(sql);
}

async function factIdOf(fact) {
    const record = dehydrateFact(fact).slice(-1)[0];
    const { rows } = await pool.query(
        `SELECT f.fact_id FROM public.fact f
         JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id
         WHERE t.name = $1 AND f.hash = $2`,
        [record.type, record.hash]);
    expect(rows.length).toBe(1);
    return rows[0].fact_id;
}

// Every fact of this run, with the shape the repair has to preserve: its hash,
// its edges, its ancestors and its signatures, each named by hash rather than
// by id so the comparison survives a renumbering.
async function factShapes() {
    const { rows } = await adminPool.query(
        `SELECT
            t.name AS type,
            f.hash,
            (SELECT array_agg(DISTINCT pt.name || ':' || p.hash ORDER BY pt.name || ':' || p.hash)
             FROM public.edge e
             JOIN public.fact p ON p.fact_id = e.predecessor_fact_id
             JOIN public.fact_type pt ON pt.fact_type_id = p.fact_type_id
             WHERE e.successor_fact_id = f.fact_id) AS predecessors,
            (SELECT array_agg(DISTINCT at.name || ':' || a.hash ORDER BY at.name || ':' || a.hash)
             FROM public.ancestor anc
             JOIN public.fact a ON a.fact_id = anc.ancestor_fact_id
             JOIN public.fact_type at ON at.fact_type_id = a.fact_type_id
             WHERE anc.fact_id = f.fact_id) AS ancestors,
            (SELECT count(*) FROM public."signature" s WHERE s.fact_id = f.fact_id) AS signatures
         FROM public.fact f
         JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id
         WHERE t.name LIKE $1
         ORDER BY t.name, f.hash`,
        [`BP${suffix}.%`]);
    return rows;
}

async function invertedEdgeCount() {
    const { rows } = await adminPool.query(
        `SELECT count(*)::int AS count FROM public.edge
         WHERE successor_fact_id < predecessor_fact_id`);
    return rows[0].count;
}

// Restores a validated constraint, whatever state a test left it in, so the
// tests after it see the schema setup.sql produces.
async function restoreValidatedConstraint() {
    await adminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
    await adminPool.query(
        `ALTER TABLE public.edge ADD CONSTRAINT ${constraintName}
         CHECK (successor_fact_id > predecessor_fact_id)`);
}

// Moves one fact's id to a fresh value, rewriting every row that names it.
// This fabricates the state a database written before the facts of one save
// were ordered can be in: raising a predecessor above its successor inverts
// their edge. The repair script is what puts such a database right; this is
// only how a test gets one.
async function moveFactId(oldFactId, newFactId, withPool) {
    const client = await (withPool || adminPool).connect();
    try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
        for (const [table, column] of [
            ['public.edge', 'fk_successor_fact_id'],
            ['public.edge', 'fk_predecessor_fact_id'],
            ['public.ancestor', 'fk_fact_id'],
            ['public.ancestor', 'fk_ancestor_fact_id'],
            ['public."signature"', 'fk_fact_id']
        ]) {
            await client.query(`ALTER TABLE ${table} ALTER CONSTRAINT ${column} DEFERRABLE INITIALLY IMMEDIATE`);
        }
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query('UPDATE public.fact SET fact_id = $2 WHERE fact_id = $1', [oldFactId, newFactId]);
        await client.query('UPDATE public.edge SET successor_fact_id = $2 WHERE successor_fact_id = $1', [oldFactId, newFactId]);
        await client.query('UPDATE public.edge SET predecessor_fact_id = $2 WHERE predecessor_fact_id = $1', [oldFactId, newFactId]);
        await client.query('UPDATE public.ancestor SET fact_id = $2 WHERE fact_id = $1', [oldFactId, newFactId]);
        await client.query('UPDATE public.ancestor SET ancestor_fact_id = $2 WHERE ancestor_fact_id = $1', [oldFactId, newFactId]);
        await client.query('UPDATE public."signature" SET fact_id = $2 WHERE fact_id = $1', [oldFactId, newFactId]);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        for (const [table, column] of [
            ['public.edge', 'fk_successor_fact_id'],
            ['public.edge', 'fk_predecessor_fact_id'],
            ['public.ancestor', 'fk_fact_id'],
            ['public.ancestor', 'fk_ancestor_fact_id'],
            ['public."signature"', 'fk_fact_id']
        ]) {
            await client.query(`ALTER TABLE ${table} ALTER CONSTRAINT ${column} NOT DEFERRABLE`);
        }
        await client.query(
            `SELECT setval(pg_get_serial_sequence('public.fact', 'fact_id'),
                           (SELECT max(fact_id) FROM public.fact))`);
        await client.query('COMMIT');
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}

async function nextFreeFactId() {
    const { rows } = await adminPool.query('SELECT coalesce(max(fact_id), 0) + 1 AS next FROM public.fact');
    return rows[0].next;
}

// Runs the feed SQL the generator emits for this bookmark in this mode.
async function readPage(feed, start, bookmark, limit, idOrderValidated) {
    const factTypes = await store.loadFactTypesFromFeed(feed);
    const roleMap = await store.loadRolesFromFeed(feed, factTypes);
    const query = sqlFromFeed(feed, start, 'public', bookmark, limit, factTypes, roleMap, idOrderValidated);
    if (!query) {
        return null;
    }
    const { rows } = await pool.query(query.sql, query.parameters);
    return rows;
}

// Runs the SQL the generator emits for an empty bookmark, with the bookmark
// parameter replaced. That is the shape the generator produced before #206,
// and the shape it still produces for an empty bookmark, so it stands in for
// the pre-#206 implementation without restating its SQL here.
async function readPageWithPreChangeSql(feed, start, bookmark, limit) {
    const factTypes = await store.loadFactTypesFromFeed(feed);
    const roleMap = await store.loadRolesFromFeed(feed, factTypes);
    const query = sqlFromFeed(feed, start, 'public', '', limit, factTypes, roleMap);
    if (!query) {
        return null;
    }
    const parameters = query.parameters.slice();
    parameters[parameters.length - 2] = parseBookmark(bookmark);
    const { rows } = await pool.query(query.sql, parameters);
    return rows;
}

function parseBookmark(bookmark) {
    return bookmark === '' ? [] : bookmark.split('.').map(part => parseInt(part, 10));
}

function bookmarkOf(row) {
    return row.bookmark.join('.');
}

function tupleOf(row) {
    return Object.keys(row)
        .filter(key => key !== 'bookmark')
        .sort()
        .map(key => `${key}=${row[key]}`)
        .join('|');
}

// Pages a feed from a bookmark until a page comes back short.
async function pageThrough(read, feed, start, limit, from) {
    const pages = [];
    let bookmark = from === undefined ? '' : from;
    for (let page = 0; page < 10000; page++) {
        const rows = await read(feed, start, bookmark, limit);
        if (rows === null || rows.length === 0) {
            break;
        }
        pages.push(rows.map(row => ({ tuple: tupleOf(row), bookmark: bookmarkOf(row) })));
        bookmark = bookmarkOf(rows[rows.length - 1]);
        if (rows.length < limit) {
            break;
        }
    }
    return pages;
}

// Sums the rows every join node in a plan actually produced. Postgres reports
// rows per loop, so a node's total is its rows times its loops. This is the
// quantity the issue measured: #206 doubles it on a two-output feed, because
// each UNION branch walks the feed once.
function totalJoinRows(plan) {
    const isJoin = node => node['Node Type'] === 'Nested Loop' ||
        node['Node Type'] === 'Hash Join' ||
        node['Node Type'] === 'Merge Join';
    let total = 0;
    const queue = [plan];
    while (queue.length > 0) {
        const node = queue.shift();
        if (isJoin(node)) {
            total += node['Actual Rows'] * node['Actual Loops'];
        }
        for (const child of node['Plans'] || []) {
            queue.push(child);
        }
    }
    return total;
}

async function explain(sql, parameters) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, parameters);
    const explained = rows[0]['QUERY PLAN'][0];
    return {
        totalJoinRows: totalJoinRows(explained['Plan']),
        executionTime: explained['Execution Time']
    };
}

const specifications = {
    "posts of a site": {
        given: "site",
        text: `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
            ]
        }`},
    "posts and their titles": {
        given: "site",
        text: `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
            ]
            title: ${titleType} [
                title->post: ${postType} = post
            ]
        }`},
    "titles superseded by a later title": {
        given: "site",
        text: `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
            ]
            title: ${titleType} [
                title->post: ${postType} = post
            ]
            next: ${titleType} [
                next->prior: ${titleType} = title
            ]
        }`},
    "current titles of posts that are not deleted": {
        given: "site",
        text: `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
                !E {
                    deleted: ${postDeletedType} [
                        deleted->post: ${postType} = post
                    ]
                }
            ]
            title: ${titleType} [
                title->post: ${postType} = post
                !E {
                    next: ${titleType} [
                        next->prior: ${titleType} = title
                    ]
                }
            ]
        }`},
    "posts that have a title": {
        given: "site",
        text: `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
                E {
                    title: ${titleType} [
                        title->post: ${postType} = post
                    ]
                }
            ]
        }`},
    "the post of a title, and that post's titles": {
        given: "title",
        text: `
        (title: ${titleType}) {
            post: ${postType} [
                post = title->post: ${postType}
            ]
            other: ${titleType} [
                other->post: ${postType} = post
            ]
        }`}
};

describe("Bookmark bound pruned by the fact id order (issue #256)", () => {
    const siteFact = site(`${suffix}.example.com`);
    const start = [dehydrateReference(siteFact)];
    let titleStart;
    let posts = [];
    let titles = [];

    function startFor(name) {
        return specifications[name].given === "title" ? titleStart : start;
    }

    beforeAll(async () => {
        store = new PostgresStore(pool, 'public');

        // Interleaved saves: a post, then titles of earlier posts, then a
        // deletion, so fact ids do not group by type and a tuple's largest id
        // is not simply its last output's.
        for (let p = 0; p < 6; p++) {
            const newPost = post(siteFact, new Date(2026, 0, p + 1).toISOString());
            posts.push(newPost);
            const batch = [newPost];
            for (let q = 0; q <= p; q++) {
                const priors = titles[q] ? [titles[q]] : [];
                const newTitle = title(posts[q], `post ${q} title ${p}`, priors);
                if (!titles[q]) {
                    titles[q] = newTitle;
                }
                batch.push(newTitle);
            }
            if (p === 2) {
                batch.push(postDeleted(posts[0]));
            }
            await store.save(envelopesOf(batch));
        }
        titleStart = [dehydrateReference(title(posts[0], `post 0 title 5`, [titles[0]]))];
    });

    afterAll(async () => {
        await restoreValidatedConstraint();
        await pool.end();
        await adminPool.end();
    });

    it("gives a predecessor the lower fact id however the batch arrives", async () => {
        // Acceptance criterion 1. The envelopes are passed successor first,
        // which is the order AuthorizationKeystore.save leaves them in when no
        // authorization rule applies. The save orders the batch itself, so the
        // insert still runs predecessors first, and the constraint, which is
        // in place throughout, accepts it.
        expect(await constraintState()).toEqual('validated');

        const lateSite = site(`late-${suffix}.example.com`);
        const latePost = post(lateSite, new Date(2026, 5, 1).toISOString());
        const lateTitle = title(latePost, 'a late title', []);
        const envelopes = envelopesOf([lateTitle]);
        // Deepest fact first: title, post, site.
        const reversed = envelopes.slice().reverse();
        expect(reversed[0].fact.type).toEqual(titleType);
        expect(reversed[reversed.length - 1].fact.type).toEqual(siteType);

        const saved = await store.save(reversed);
        expect(saved.length).toEqual(envelopes.length);

        const siteId = await factIdOf(lateSite);
        const postId = await factIdOf(latePost);
        const titleId = await factIdOf(lateTitle);
        expect(siteId).toBeLessThan(postId);
        expect(postId).toBeLessThan(titleId);
        expect(await invertedEdgeCount()).toBe(0);
    });

    it("adds the constraint unvalidated on a database that holds an inverted edge", async () => {
        // Acceptance criterion 2. A database written before the batch was
        // ordered can hold an inverted edge. setup.sql adds the constraint
        // NOT VALID, so it is not validated, and a later inverted edge is
        // refused all the same.
        const invertedSite = site(`inverted-${suffix}.example.com`);
        const invertedPost = post(invertedSite, new Date(2026, 6, 1).toISOString());
        await store.save(envelopesOf([invertedPost]));
        const siteId = await factIdOf(invertedSite);
        const postId = await factIdOf(invertedPost);
        expect(siteId).toBeLessThan(postId);

        // Raise the site above its post, which inverts their edge.
        const raisedSiteId = await nextFreeFactId();
        await moveFactId(siteId, raisedSiteId);
        expect(await invertedEdgeCount()).toBeGreaterThan(0);

        try {
            await runSqlFile(setupSqlPath);
            expect(await constraintState()).toEqual('unvalidated');

            // A new inverted edge is refused by the unvalidated constraint.
            const roleResult = await adminPool.query(
                `SELECT r.role_id FROM public.role r
                 JOIN public.fact_type t ON t.fact_type_id = r.defining_fact_type_id
                 WHERE t.name = $1 AND r.name = 'site'`,
                [postType]);
            expect(roleResult.rows.length).toBe(1);
            await expect(adminPool.query(
                `INSERT INTO public.edge (role_id, successor_fact_id, predecessor_fact_id)
                 VALUES ($1, $2, $3)`,
                [roleResult.rows[0].role_id, postId, raisedSiteId]))
                .rejects.toThrow(constraintName);
        }
        finally {
            // Put the order back, so the tests after this one see the schema
            // setup.sql produces on a database with nothing to repair.
            await runSqlFile(repairSqlPath);
        }
        expect(await invertedEdgeCount()).toBe(0);
        expect(await constraintState()).toEqual('validated');
    });

    it("moves an inverted fact and its descendants, and nothing else", async () => {
        // Acceptance criterion 3.
        const repairSite = site(`repair-${suffix}.example.com`);
        const repairPost = post(repairSite, new Date(2026, 7, 1).toISOString());
        const repairTitle = title(repairPost, 'a title to repair', []);
        await store.save(envelopesOf([repairTitle]));

        const siteId = await factIdOf(repairSite);
        const postId = await factIdOf(repairPost);
        const titleId = await factIdOf(repairTitle);

        // Raising the site above the post inverts the post's edge to it, and
        // the title is the post's descendant, so the repair has to move the
        // post and the title and leave the site where it is.
        const raisedSiteId = await nextFreeFactId();
        await moveFactId(siteId, raisedSiteId);
        expect(await invertedEdgeCount()).toBe(1);

        const before = await factShapes();
        const { rows: maxBefore } = await adminPool.query('SELECT max(fact_id) AS max FROM public.fact');
        const previousMaximum = Number(maxBefore[0].max);

        const started = Date.now();
        await runSqlFile(repairSqlPath);
        const repairMilliseconds = Date.now() - started;
        console.log(`repair-edge-order.sql took ${repairMilliseconds} ms`);

        // The post and the title moved above the previous maximum. The site
        // did not move: nothing is descended from the inverted edge's
        // predecessor.
        const movedPostId = await factIdOf(repairPost);
        const movedTitleId = await factIdOf(repairTitle);
        expect(movedPostId).toBeGreaterThan(previousMaximum);
        expect(movedTitleId).toBeGreaterThan(previousMaximum);
        expect(await factIdOf(repairSite)).toEqual(raisedSiteId);
        expect(movedPostId).not.toEqual(postId);
        expect(movedTitleId).not.toEqual(titleId);

        // Each moved fact's id is above its own predecessors'.
        expect(movedPostId).toBeGreaterThan(raisedSiteId);
        expect(movedTitleId).toBeGreaterThan(movedPostId);
        expect(await invertedEdgeCount()).toBe(0);

        // Afterwards the constraint is validated and no foreign key on fact is
        // deferrable.
        expect(await constraintState()).toEqual('validated');
        expect(await deferrableForeignKeys()).toEqual([]);

        // Every fact kept its hash, its edges, its ancestors and its
        // signatures. The shapes name facts by hash, so they compare across
        // the renumbering.
        const after = await factShapes();
        expect(after).toEqual(before);

        // A second run moves nothing and succeeds.
        const idsBeforeSecondRun = await factShapes();
        const movedPostIdBefore = await factIdOf(repairPost);
        await runSqlFile(repairSqlPath);
        expect(await factIdOf(repairPost)).toEqual(movedPostIdBefore);
        expect(await factShapes()).toEqual(idsBeforeSecondRun);
        expect(await constraintState()).toEqual('validated');
    });

    it("redelivers at most, and never skips, across the repair", async () => {
        // Acceptance criterion 4. A reader holds a bookmark taken before the
        // repair. Afterwards it pages from that bookmark, and receives every
        // tuple it had not already seen. It may receive tuples it has seen
        // again, which is harmless: a client deduplicates facts by hash.
        const name = "posts and their titles";
        const specification = parseSpecification(specifications[name].text).specification;
        const feeds = buildFeeds(specification);
        expect(feeds.length).toBe(1);
        const feed = feeds[0];
        const read = (f, s, b, l) => readPage(f, s, b, l, true);

        const pagesBefore = await pageThrough(read, feed, startFor(name), 2);
        const allTuples = pagesBefore.flat().map(row => row.tuple);
        expect(allTuples.length).toBeGreaterThan(2);
        expect(pagesBefore.length).toBeGreaterThan(1);

        // The reader has taken the first page and holds its bookmark.
        const received = new Set(pagesBefore[0].map(row => row.tuple));
        const bookmark = pagesBefore[0][pagesBefore[0].length - 1].bookmark;
        const remaining = allTuples.filter(tuple => !received.has(tuple));
        expect(remaining.length).toBeGreaterThan(0);

        // Invert the site of this run's feed, so the repair moves every post
        // and title the feed carries.
        const siteId = await factIdOf(siteFact);
        const raisedSiteId = await nextFreeFactId();
        await moveFactId(siteId, raisedSiteId);
        expect(await invertedEdgeCount()).toBeGreaterThan(0);
        await runSqlFile(repairSqlPath);
        expect(await constraintState()).toEqual('validated');

        const pagesAfter = await pageThrough(read, feed, startFor(name), 2, bookmark);
        const delivered = new Set(pagesAfter.flat().map(row => row.tuple));
        for (const tuple of remaining) {
            expect(delivered.has(tuple)).toBe(true);
        }
        // Nothing outside the feed arrived.
        const everything = new Set(allTuples);
        for (const tuple of delivered) {
            expect(everything.has(tuple)).toBe(true);
        }
    });

    it("pages the same way the pre-#206 SQL does, with the bound pruned", async () => {
        // Acceptance criterion 9, in the pruned mode. #206's own differential
        // test covers the unpruned mode and is unchanged. The pre-#206 SQL is
        // not restated here: it is what the generator still emits for an empty
        // bookmark, run with the bookmark parameter substituted.
        for (const name of Object.keys(specifications)) {
            const specification = parseSpecification(specifications[name].text).specification;
            const feeds = buildFeeds(specification);
            for (let f = 0; f < feeds.length; f++) {
                for (const limit of [1, 2, 3, 100]) {
                    const pruned = await pageThrough(
                        (feed, s, b, l) => readPage(feed, s, b, l, true),
                        feeds[f], startFor(name), limit);
                    const preChange = await pageThrough(
                        readPageWithPreChangeSql, feeds[f], startFor(name), limit);
                    expect({ name, feed: f, limit, pages: pruned })
                        .toEqual({ name, feed: f, limit, pages: preChange });
                }
            }
        }
    });

    it("returns every tuple of the feed across its pages, with the bound pruned", async () => {
        // The differential above cannot pass by both sides returning nothing,
        // because this pins the content of one of them.
        const name = "posts and their titles";
        const specification = parseSpecification(specifications[name].text).specification;
        const feeds = buildFeeds(specification);
        const pages = await pageThrough(
            (feed, s, b, l) => readPage(feed, s, b, l, true),
            feeds[0], startFor(name), 2);
        const tuples = pages.flat().map(row => row.tuple);
        expect(tuples.length).toBeGreaterThan(5);
        expect(new Set(tuples).size).toEqual(tuples.length);
        const whole = await pageThrough(
            (feed, s, b, l) => readPage(feed, s, b, l, true),
            feeds[0], startFor(name), 1000);
        expect(new Set(whole.flat().map(row => row.tuple))).toEqual(new Set(tuples));
    });
});

describe("Plan rows on a deep page (issue #256)", () => {
    // Acceptance criterion 10. On a two-output chain feed with at least 10,000
    // tuples, read from the bookmark the first page returns, the rows the
    // plan's join nodes actually produce are at most those of the pre-#206
    // SQL. #206 doubles that total, because each of its two UNION branches
    // walks the feed once and the results are then hashed to deduplicate.
    const planSuffix = Math.random().toString(36).slice(2, 10);
    const planSiteType = `BR${planSuffix}.Site`;
    const planPostType = `BR${planSuffix}.Post`;
    const planTitleType = `BR${planSuffix}.Post.Title`;
    const tupleCount = 10000;
    const planPool = new Pool({ connectionString });
    const planSite = { type: planSiteType, domain: `${planSuffix}.example.com` };
    let planStore;

    const planSpecification = `
        (site: ${planSiteType}) {
            post: ${planPostType} [
                post->site: ${planSiteType} = site
            ]
            title: ${planTitleType} [
                title->post: ${planPostType} = post
            ]
        }`;

    beforeAll(async () => {
        planStore = new PostgresStore(planPool, 'public');
        // Interleaved within each batch: the post and its title are saved
        // together, so their ids alternate rather than grouping by type.
        const batchSize = 500;
        for (let first = 0; first < tupleCount; first += batchSize) {
            const records = [];
            for (let p = first; p < Math.min(first + batchSize, tupleCount); p++) {
                const onePost = { type: planPostType, site: planSite, createdAt: `post ${p}` };
                const oneTitle = { type: planTitleType, post: onePost, value: `title ${p}`, prior: [] };
                for (const record of dehydrateFact(oneTitle)) {
                    if (!records.some(r => r.type === record.type && r.hash === record.hash)) {
                        records.push(record);
                    }
                }
            }
            await planStore.save(records.map(fact => ({ fact, signatures: [] })));
        }
        await planPool.query('ANALYZE public.fact');
        await planPool.query('ANALYZE public.edge');
    });

    afterAll(async () => {
        await planPool.end();
    });

    it("produces no more join rows than the pre-#206 SQL, at every position", async () => {
        const specification = parseSpecification(planSpecification).specification;
        const feeds = buildFeeds(specification);
        expect(feeds.length).toBe(1);
        const feed = feeds[0];
        const start = [dehydrateReference(planSite)];
        const factTypes = await planStore.loadFactTypesFromFeed(feed);
        const roleMap = await planStore.loadRolesFromFeed(feed, factTypes);

        // The whole feed, to take bookmarks from. Pages run in ascending
        // bookmark order, so the bookmark the first page returns is near the
        // beginning of the feed and the page after it is the deep one the
        // issue measured.
        const limit = 100;
        const page = sqlFromFeed(feed, start, 'public', '', limit, factTypes, roleMap);
        const whole = sqlFromFeed(feed, start, 'public', '', tupleCount + 1, factTypes, roleMap);
        const { rows } = await planPool.query(whole.sql, whole.parameters);
        expect(rows.length).toEqual(tupleCount);

        const positions = {
            "first page": limit - 1,
            "middle": Math.floor(tupleCount / 2),
            "50 from the end": tupleCount - 51,
            "caught up": tupleCount - 1
        };

        const explainOn = async (sql, parameters) => {
            const { rows: explained } = await planPool.query(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, parameters);
            const plan = explained[0]['QUERY PLAN'][0];
            return {
                totalJoinRows: totalJoinRows(plan['Plan']),
                executionTime: plan['Execution Time']
            };
        };
        const rowsOf = async (sql, parameters) => {
            const { rows: read } = await planPool.query(sql, parameters);
            return read.map(row => tupleOf(row));
        };

        console.log(`tuples in the feed: ${tupleCount}`);
        for (const [label, index] of Object.entries(positions)) {
            const bookmark = rows[index].bookmark.join('.');
            const preChangeParameters = page.parameters.slice();
            preChangeParameters[preChangeParameters.length - 2] = parseBookmark(bookmark);
            const unpruned = sqlFromFeed(feed, start, 'public', bookmark, limit, factTypes, roleMap, false);
            const pruned = sqlFromFeed(feed, start, 'public', bookmark, limit, factTypes, roleMap, true);
            expect(pruned.sql).not.toContain('UNION');
            expect(unpruned.sql).toContain('UNION');

            // All three forms return the same page, so the row counts below
            // are three ways of producing one answer.
            const preChangePage = await rowsOf(page.sql, preChangeParameters);
            expect(await rowsOf(unpruned.sql, unpruned.parameters)).toEqual(preChangePage);
            expect(await rowsOf(pruned.sql, pruned.parameters)).toEqual(preChangePage);

            const preChange = await explainOn(page.sql, preChangeParameters);
            const withUnion = await explainOn(unpruned.sql, unpruned.parameters);
            const withPruning = await explainOn(pruned.sql, pruned.parameters);
            console.log(`${label}: pre-#206 ${preChange.totalJoinRows} join rows ` +
                `(${preChange.executionTime.toFixed(1)} ms), ` +
                `#206 ${withUnion.totalJoinRows} (${withUnion.executionTime.toFixed(1)} ms), ` +
                `#256 ${withPruning.totalJoinRows} (${withPruning.executionTime.toFixed(1)} ms)`);

            // Acceptance criterion 10, which names the first-page bookmark and
            // holds at every position: the pruned bound produces no more join
            // rows than the SQL that had no bound at all.
            expect(withPruning.totalJoinRows).toBeLessThanOrEqual(preChange.totalJoinRows);
            // And no more than #206's, which is what the issue is about.
            expect(withPruning.totalJoinRows).toBeLessThanOrEqual(withUnion.totalJoinRows);
            if (label === "first page") {
                // The defect: #206 produces more than the SQL with no bound.
                expect(withUnion.totalJoinRows).toBeGreaterThan(preChange.totalJoinRows);
            }
            if (label === "caught up") {
                // What #206 bought survives the pruning: the branch that is
                // kept is the one that bounds the walk.
                expect(withPruning.totalJoinRows).toBeLessThan(preChange.totalJoinRows);
            }
        }
    });
});

describe("The id order flag (issue #256)", () => {
    // Acceptance criterion 11. The flag is read once, on the first feed, and
    // the warning says what the operator has to do.
    const flagSuffix = Math.random().toString(36).slice(2, 10);
    const flagSiteType = `BF${flagSuffix}.Site`;
    const flagPostType = `BF${flagSuffix}.Post`;
    const flagPool = new Pool({ connectionString });
    const flagAdminPool = new Pool({ connectionString: adminConnectionString, max: 2 });

    const flagSpecification = `
        (site: ${flagSiteType}) {
            post: ${flagPostType} [
                post->site: ${flagSiteType} = site
            ]
        }`;
    const flagSite = { type: flagSiteType, domain: `${flagSuffix}.example.com` };
    const flagPost = { type: flagPostType, site: flagSite, createdAt: '2026-01-01' };

    let warnings;
    let countingPool;
    let constraintQueries;

    beforeAll(async () => {
        const seedStore = new PostgresStore(flagPool, 'public');
        const records = [];
        for (const record of dehydrateFact(flagPost)) {
            records.push({ fact: record, signatures: [] });
        }
        await seedStore.save(records);
    });

    beforeEach(() => {
        warnings = [];
        constraintQueries = 0;
        Trace.configure({
            info: () => { },
            warn: message => warnings.push(message),
            error: () => { },
            dependency: () => { },
            metric: () => { },
            counter: () => { }
        });
        // Counts the statements a store runs, so a second feed that asks the
        // database about the constraint again would be visible. The client is
        // wrapped rather than altered: a pool hands the same client out again,
        // and altering it would stack one wrapper per checkout.
        countingPool = {
            connect: async () => {
                const client = await flagPool.connect();
                return {
                    query: (sql, parameters) => {
                        if (typeof sql === 'string' && sql.includes('pg_constraint')) {
                            constraintQueries++;
                        }
                        return client.query(sql, parameters);
                    },
                    release: () => client.release()
                };
            }
        };
    });

    afterAll(async () => {
        Trace.configure(null);
        await flagAdminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
        await flagAdminPool.query(
            `ALTER TABLE public.edge ADD CONSTRAINT ${constraintName}
             CHECK (successor_fact_id > predecessor_fact_id)`);
        await flagPool.end();
        await flagAdminPool.end();
    });

    async function feedTwice(store) {
        const specification = parseSpecification(flagSpecification).specification;
        const feed = buildFeeds(specification)[0];
        const start = [dehydrateReference(flagSite)];
        const first = await store.feed(feed, start, '');
        const second = await store.feed(feed, start, '');
        return { first, second };
    }

    it("logs no warning, and asks once, when the constraint is validated", async () => {
        await flagAdminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
        await flagAdminPool.query(
            `ALTER TABLE public.edge ADD CONSTRAINT ${constraintName}
             CHECK (successor_fact_id > predecessor_fact_id)`);

        const store = new PostgresStore(countingPool, 'public');
        const { first, second } = await feedTwice(store);
        expect(first.tuples.length).toBeGreaterThan(0);
        expect(second.tuples.length).toEqual(first.tuples.length);
        expect(warnings).toEqual([]);
        expect(constraintQueries).toBe(1);
    });

    it("logs one warning naming setup.sql when the constraint is missing", async () => {
        await flagAdminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);

        const store = new PostgresStore(countingPool, 'public');
        await feedTwice(store);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain(constraintName);
        expect(warnings[0]).toContain('setup.sql');
        expect(constraintQueries).toBe(1);
    });

    it("logs one warning with the violation count when the constraint is unvalidated", async () => {
        await flagAdminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
        await flagAdminPool.query(
            `ALTER TABLE public.edge ADD CONSTRAINT ${constraintName}
             CHECK (successor_fact_id > predecessor_fact_id) NOT VALID`);

        const store = new PostgresStore(countingPool, 'public');
        await feedTwice(store);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain(constraintName);
        // No edge is inverted, so the count is zero and the remedy is to run
        // setup.sql, which validates the constraint.
        expect(warnings[0]).toContain('0 edges');
        expect(warnings[0]).toContain('setup.sql');
        expect(constraintQueries).toBe(1);
    });

    it("names the repair when the violation count is not zero", async () => {
        // The other half of the unvalidated case: an inverted edge really is
        // there, so the count says how many and the remedy is the repair.
        const { rows: siteRows } = await flagPool.query(
            `SELECT f.fact_id FROM public.fact f
             JOIN public.fact_type t ON t.fact_type_id = f.fact_type_id
             WHERE t.name = $1`,
            [flagSiteType]);
        expect(siteRows.length).toBe(1);
        const { rows: maxRows } = await flagAdminPool.query(
            'SELECT coalesce(max(fact_id), 0) + 1 AS next FROM public.fact');
        await moveFactId(siteRows[0].fact_id, maxRows[0].next, flagAdminPool);
        await flagAdminPool.query(`ALTER TABLE public.edge DROP CONSTRAINT IF EXISTS ${constraintName}`);
        await flagAdminPool.query(
            `ALTER TABLE public.edge ADD CONSTRAINT ${constraintName}
             CHECK (successor_fact_id > predecessor_fact_id) NOT VALID`);

        try {
            const store = new PostgresStore(countingPool, 'public');
            await feedTwice(store);
            expect(warnings.length).toBe(1);
            expect(warnings[0]).toContain(constraintName);
            expect(warnings[0]).toContain('1 edge ');
            expect(warnings[0]).toContain('repair-edge-order.sql');
            expect(constraintQueries).toBe(1);
        }
        finally {
            await runSqlFile(repairSqlPath, flagAdminPool);
        }
    });
});
