const { Pool } = require('pg');
const { buildFeeds, dehydrateFact, dehydrateReference } = require('jinaga');
const { PostgresStore } = require('./jinaga-server');
const { parseSpecification } = require('./test-helpers');

// Issue #206. The feed query filtered on `sort(array[...], 'desc') > $bookmark`,
// a value computed from the joined row, so no index could serve it: Postgres
// had to build every tuple of the feed, compute each bookmark, sort them, and
// discard the ones at or before the bookmark. Reading the newest page cost as
// much as reading the whole history.
//
// The generator now adds the condition that the bookmark filter implies — some
// output fact of the tuple has `fact_id >= bookmark[0]` — one branch per output
// fact so that an index can serve it, combined with UNION.
//
// Two things need a database. The first is that the implied condition changes
// no result: `pages the same way the pre-change SQL does` compares the new
// paging against the pre-change SQL, which the generator still emits for an
// empty bookmark. The second is that the condition actually reaches the
// planner: `reads a page without enumerating the feed` measures the plan.
//
// `sqlFromFeed` is not part of the package's public API, so these tests reach
// the module inside the built package. They are measuring generated SQL, which
// is the thing the issue is about.
const { sqlFromFeed } = require('./jinaga-server/dist/postgres/specification-sql');

jest.setTimeout(120000);

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const siteType = `BM${suffix}.Site`;
const postType = `BM${suffix}.Post`;
const titleType = `BM${suffix}.Post.Title`;
const postDeletedType = `BM${suffix}.Post.Deleted`;

// The blog model of test/models/blog.ts: a site, its posts, each post's titles
// chained through `prior`, and a deletion fact for a post.
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
    // One envelope per fact record, unsigned. The feed query reads `fact` and
    // `edge`, neither of which carries a signature.
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

// The specifications whose feeds are paged. Between them they cover a feed with
// one output fact, feeds with two and three, a feed carrying a negative
// existential condition, and a feed carrying a positive one.
const specifications = {
    "posts of a site": `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
            ]
        }`,
    "posts and their titles": `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
            ]
            title: ${titleType} [
                title->post: ${postType} = post
            ]
        }`,
    "titles superseded by a later title": `
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
        }`,
    "current titles of posts that are not deleted": `
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
        }`,
    "posts that have a title": `
        (site: ${siteType}) {
            post: ${postType} [
                post->site: ${siteType} = site
                E {
                    title: ${titleType} [
                        title->post: ${postType} = post
                    ]
                }
            ]
        }`
};

const pool = new Pool({ connectionString });
let store;

// Runs the feed SQL the generator emits for `bookmark`, which carries the
// implied condition whenever the bookmark is not empty.
async function readPage(feed, start, bookmark, limit) {
    const factTypes = await store.loadFactTypesFromFeed(feed);
    const roleMap = await store.loadRolesFromFeed(feed, factTypes);
    const query = sqlFromFeed(feed, start, 'public', bookmark, limit, factTypes, roleMap);
    if (!query) {
        return null;
    }
    const { rows } = await pool.query(query.sql, query.parameters);
    return rows;
}

// Runs the SQL the generator emits for an *empty* bookmark, with the bookmark
// parameter replaced by this bookmark. That is the shape the generator produced
// before this change, and the shape it still produces for an empty bookmark, so
// it stands in for the pre-change implementation without restating its SQL
// here. The bookmark is the second-from-last parameter, ahead of the limit.
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
    // The same string form PostgresStore gives a caller.
    return row.bookmark.join('.');
}

// Pages a feed from the empty bookmark until a page comes back short, and
// returns the pages as the caller would see them.
async function pageThrough(read, feed, start, limit) {
    const pages = [];
    let bookmark = '';
    for (let page = 0; page < 1000; page++) {
        const rows = await read(feed, start, bookmark, limit);
        if (rows === null || rows.length === 0) {
            break;
        }
        pages.push(rows.map(row => ({
            hashes: Object.keys(row).filter(key => key !== 'bookmark').sort().map(key => `${key}=${row[key]}`),
            bookmark: bookmarkOf(row)
        })));
        bookmark = bookmarkOf(rows[rows.length - 1]);
        if (rows.length < limit) {
            break;
        }
    }
    return pages;
}

// Walks an `EXPLAIN (ANALYZE, FORMAT JSON)` plan and returns the largest number
// of rows any join node in it actually produced. Postgres reports rows per loop,
// so a node's total is its rows times its loops.
//
// The issue's criterion 3 names the *top* join node, on the expectation that it
// reports the feed's tuple count. It does not: the top join is where the
// bookmark filter is applied, so it reports the page, and the enumeration the
// issue is about shows up at the joins beneath it. The largest join node is the
// quantity the criterion was reaching for, so that is what this measures.
function largestJoinRows(plan) {
    const isJoin = node => node['Node Type'] === 'Nested Loop' ||
        node['Node Type'] === 'Hash Join' ||
        node['Node Type'] === 'Merge Join';
    let largest = 0;
    const queue = [plan];
    while (queue.length > 0) {
        const node = queue.shift();
        if (isJoin(node)) {
            largest = Math.max(largest, node['Actual Rows'] * node['Actual Loops']);
        }
        for (const child of node['Plans'] || []) {
            queue.push(child);
        }
    }
    return largest;
}

async function explain(sql, parameters) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, parameters);
    const explained = rows[0]['QUERY PLAN'][0];
    return {
        largestJoinRows: largestJoinRows(explained['Plan']),
        executionTime: explained['Execution Time']
    };
}

describe("Feed bookmark filter (issue #206)", () => {
    const siteFact = site(`${suffix}.example.com`);
    const start = [dehydrateReference(siteFact)];

    beforeAll(async () => {
        store = new PostgresStore(pool, 'public');

        // Interleaved saves: a post, then titles of earlier posts, then a
        // deletion, so that fact_ids do not group by type and a tuple's
        // largest fact_id is not simply its last output's.
        const posts = [];
        const titles = [];
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
    });

    afterAll(async () => {
        await pool.end();
    });

    it("pages the same way the pre-change SQL does", async () => {
        // Acceptance criterion 2. Every feed of every specification, paged from
        // the empty bookmark, yields the same pages, tuples and bookmarks as
        // the pre-change SQL yields for the same bookmarks.
        for (const name of Object.keys(specifications)) {
            const specification = parseSpecification(specifications[name]).specification;
            const feeds = buildFeeds(specification);
            expect(feeds.length).toBeGreaterThan(0);
            for (let f = 0; f < feeds.length; f++) {
                for (const limit of [1, 2, 3, 100]) {
                    const current = await pageThrough(readPageWithPreChangeSql, feeds[f], start, limit);
                    const paged = await pageThrough(readPage, feeds[f], start, limit);
                    expect({ name, feed: f, limit, pages: paged })
                        .toEqual({ name, feed: f, limit, pages: current });
                }
            }
        }
    });

    it("returns every tuple of the feed across its pages", async () => {
        // A differential against an implementation that pages identically
        // would pass vacuously if both returned nothing. Pin the content too:
        // paging a feed in pages of one returns exactly the tuples a single
        // unpaged read returns, in the same order. The unpaged read runs the
        // empty-bookmark SQL, which this change does not touch.
        for (const name of Object.keys(specifications)) {
            const specification = parseSpecification(specifications[name]).specification;
            const feeds = buildFeeds(specification);
            for (let f = 0; f < feeds.length; f++) {
                const whole = await readPage(feeds[f], start, '', 1000);
                const pages = await pageThrough(readPage, feeds[f], start, 1);
                const paged = pages.reduce((all, page) => all.concat(page), []);
                expect({ name, feed: f, tuples: paged.map(tuple => tuple.bookmark) })
                    .toEqual({ name, feed: f, tuples: whole.map(bookmarkOf) });
                expect(paged.length).toBeGreaterThan(0);
            }
        }
    });

    it("reads a page without enumerating the feed", async () => {
        // Acceptance criterion 3. Seed a feed with more than 10,000 tuples,
        // take the bookmark 50 tuples before the end, and measure the plan of
        // that page under the pre-change SQL and under the new SQL.
        const bigSite = site(`big.${suffix}.example.com`);
        const bigStart = [dehydrateReference(bigSite)];
        const postCount = 110;
        const titlesPerPost = 100;
        for (let p = 0; p < postCount; p++) {
            const newPost = post(bigSite, new Date(2026, 1, 1 + p).toISOString());
            const batch = [newPost];
            for (let q = 0; q < titlesPerPost; q++) {
                batch.push(title(newPost, `title ${p}.${q}`, []));
            }
            await store.save(envelopesOf(batch));
        }

        const specification = parseSpecification(specifications["posts and their titles"]).specification;
        const feeds = buildFeeds(specification);
        expect(feeds.length).toBe(1);
        const feed = feeds[0];

        const whole = await readPage(feed, bigStart, '', 1000000);
        expect(whole.length).toBeGreaterThanOrEqual(10000);
        const bookmark = bookmarkOf(whole[whole.length - 50]);

        const factTypes = await store.loadFactTypesFromFeed(feed);
        const roleMap = await store.loadRolesFromFeed(feed, factTypes);
        const pagedQuery = sqlFromFeed(feed, bigStart, 'public', bookmark, 100, factTypes, roleMap);
        const preChangeQuery = sqlFromFeed(feed, bigStart, 'public', '', 100, factTypes, roleMap);
        const preChangeParameters = preChangeQuery.parameters.slice();
        preChangeParameters[preChangeParameters.length - 2] = parseBookmark(bookmark);

        await pool.query('ANALYZE public.fact');
        await pool.query('ANALYZE public.edge');

        const before = await explain(preChangeQuery.sql, preChangeParameters);
        const after = await explain(pagedQuery.sql, pagedQuery.parameters);

        // Reported so a pull request can quote measured numbers rather than an
        // expectation.
        console.log(`tuples in feed: ${whole.length}`);
        console.log(`largest join node rows, pre-change SQL: ${before.largestJoinRows}` +
            ` (${before.executionTime.toFixed(1)} ms)`);
        console.log(`largest join node rows, new SQL: ${after.largestJoinRows}` +
            ` (${after.executionTime.toFixed(1)} ms)`);

        // The pre-change SQL builds every tuple of the feed to read one page.
        expect(before.largestJoinRows).toBeGreaterThanOrEqual(whole.length);
        expect(after.largestJoinRows).toBeLessThanOrEqual(1000);

        // The page itself is unchanged.
        const pagedRows = await pool.query(pagedQuery.sql, pagedQuery.parameters);
        const preChangeRows = await pool.query(preChangeQuery.sql, preChangeParameters);
        expect(pagedRows.rows.map(bookmarkOf)).toEqual(preChangeRows.rows.map(bookmarkOf));
        expect(pagedRows.rows.length).toBe(49);
    });
});
