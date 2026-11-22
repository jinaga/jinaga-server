import { buildFeeds, dehydrateReference, getAllFactTypes, getAllRoles, Specification, SpecificationParser } from "jinaga";

import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, RoleMap } from "../../src/postgres/maps";
import { sqlFromFeed } from "../../src/postgres/specification-sql";

// Regression coverage for jinaga-server#206.
//
// The feed query filtered on `sort(array[...], 'desc') > $bookmark`, a value
// computed from the joined row, which no index can serve: every page had to
// build every tuple of the feed and discard the ones at or before the bookmark.
//
// A bookmark is the tuple's fact_ids sorted descending, compared as arrays, so
// `b > B` implies `b[0] >= B[0]`, and `b[0]` is the largest fact_id in the
// tuple. Some output fact of every returned tuple therefore has
// `fact_id >= B[0]`. The generator now adds that implied condition, one branch
// per output fact so that an index can serve it, combined with UNION.
//
// The condition is stated on the edge column that brought the output fact into
// the query rather than on that fact's own primary key. The two are equivalent,
// because the join equates them, but Postgres does not carry an inequality
// across an equijoin, and only the edge column joins the index that serves the
// walk.
//
// These tests pin the generated SQL for an empty and a non-empty bookmark. The
// differential paging test and the query-plan measurement are in
// `integration-test/`, which needs a database.

function parseSpecification(input: string): Specification {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function buildMaps(specification: Specification): { factTypes: FactTypeMap; roleMap: RoleMap } {
    // Deterministic ids in first-seen order, matching the convention in
    // userGivenFeedSqlSpec: types from 1, roles offset past them.
    const factTypes = getAllFactTypes(specification)
        .filter(factType => factType !== 'Unknown')
        .reduce((f, factType, i) => addFactType(f, factType, i + 1), emptyFactTypeMap());
    const roleMap = getAllRoles(specification)
        .filter(role => role.name !== 'unknown')
        .reduce((r, role, i) => {
            const factTypeId = getFactTypeId(factTypes, role.successorType);
            if (!factTypeId) {
                return r;
            }
            return addRole(r, factTypeId, role.name, i + 100);
        }, emptyRoleMap());
    return { factTypes, roleMap };
}

const site = dehydrateReference({ type: "Blog.Site", domain: "blog.example.com" });

// Generates the feed SQL for a single-feed specification at a given bookmark.
function feedSqlFor(descriptiveString: string, bookmark: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = buildMaps(specification);
    const feeds = buildFeeds(specification);
    const query = sqlFromFeed(feeds[0], [site], "public", bookmark, 100, factTypes, roleMap);
    return { query, feedCount: feeds.length };
}

// One output fact: the feed projects posts of a site.
const ONE_OUTPUT = `
    (site: Blog.Site) {
        post: Blog.Post [
            post->site: Blog.Site = site
        ]
    }`;

// Two output facts: the feed projects each post and each of its titles, so a
// tuple carries two fact_ids and the bookmark is a two-element array.
const TWO_OUTPUTS = `
    (site: Blog.Site) {
        post: Blog.Post [
            post->site: Blog.Site = site
        ]
        title: Blog.Post.Title [
            title->post: Blog.Post = post
        ]
    }`;

// Reads out of the generated SQL the edge column that brought an output fact
// into the query, which is the column its branch must be anchored on. The query
// joins a fact it reaches through an edge as
// `JOIN <schema>.fact fN ON fN.fact_id = eK.successor_fact_id`, so the join
// itself says which column that is. A fact no edge brought in — the query's
// first fact — has no such join, and falls back to its own primary key.
function anchorColumnOf(sql: string, factIndex: number) {
    const join = new RegExp(
        `JOIN \\S+\\.fact f${factIndex} ON f${factIndex}\\.fact_id = (e\\d+\\.(?:successor|predecessor)_fact_id)`);
    const match = join.exec(sql);
    return match ? match[1] : `f${factIndex}.fact_id`;
}

// The post is reached by walking back from the given title, so the query brings
// it in as the predecessor of that edge. Its sibling titles are reached forward
// from the post, so one feed carries an output anchored on an edge's
// `predecessor_fact_id` and another on a `successor_fact_id`.
const BOTH_WALK_DIRECTIONS = `
    (title: Blog.Post.Title) {
        post: Blog.Post [
            post = title->post: Blog.Post
        ]
        other: Blog.Post.Title [
            other->post: Blog.Post = post
        ]
    }`;

const titleGiven = dehydrateReference({ type: "Blog.Post.Title", value: "a title" });

// Generates the feed SQL for a single-feed specification read from a title.
function titleFeedSqlFor(descriptiveString: string, bookmark: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = buildMaps(specification);
    const feeds = buildFeeds(specification);
    return {
        query: sqlFromFeed(feeds[0], [titleGiven], "public", bookmark, 100, factTypes, roleMap),
        feedCount: feeds.length
    };
}

// `buildFeeds` lifts a positive existential condition into the feed's matches,
// and an identity inside one can unify the condition's unknown with a given. The
// given is then an output of the feed, as boundIdentitySqlSpec pins. No edge
// brought it into the query, so its branch has no edge column to anchor on.
const GIVEN_AS_OUTPUT = `
    (office: Office, company: Company) {
        president: President [
            president->office: Office = office
            !E {
                o: Office [
                    o = office
                    o = president->office: Office
                ]
            }
        ]
    } => president`;

const office = dehydrateReference({ type: "Office" });
const company = dehydrateReference({ type: "Company" });

// Generates the feed SQL for every feed of a two-given specification, binding
// each feed's givens by type.
function feedSqlsFor(descriptiveString: string, bookmark: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = buildMaps(specification);
    return buildFeeds(specification).map(feed => {
        const start = feed.given.map(given => given.label.type === "Office" ? office : company);
        return sqlFromFeed(feed, start, "public", bookmark, 100, factTypes, roleMap);
    });
}

// Rebuilds the expected non-empty-bookmark SQL from the generator's own
// empty-bookmark SQL. Only the wrapper, the per-output anchors and the
// parameter numbering are stated here; the joins and the WHERE clause are taken
// from the other output, so this assertion fails when the wrapper is wrong and
// not merely when the joins are reworded.
function wrapEmptyBookmarkSql(emptySql: string, outputFactIndexes: number[], parameterCount: number) {
    const filterIndex = emptySql.lastIndexOf(" AND sort(array[");
    expect(filterIndex).toBeGreaterThan(0);
    const matches = emptySql.substring(0, filterIndex);
    const orderingIndex = emptySql.indexOf("ORDER BY bookmark ASC", filterIndex);
    expect(orderingIndex).toBeGreaterThan(filterIndex);
    const ordering = emptySql.substring(orderingIndex);

    // The empty-bookmark parameter list is the query's own parameters followed
    // by the bookmark and the limit, so the bookmark is second from last and
    // the anchor takes the next number after the limit.
    const bookmarkParameter = parameterCount - 1;
    const limitParameter = parameterCount;
    const firstParameter = limitParameter + 1;
    expect(ordering).toContain(`LIMIT $${limitParameter}`);

    const branches = outputFactIndexes
        .map(factIndex => anchorColumnOf(emptySql, factIndex))
        .map(anchorColumn => `${matches} AND ${anchorColumn} >= $${firstParameter}`)
        .join(" UNION ");
    return `SELECT * FROM (${branches}) AS matches WHERE bookmark > $${bookmarkParameter} ${ordering}`;
}

describe("Feed bookmark filter (issue #206)", () => {
    it("generates the unwrapped query for an empty bookmark", () => {
        // Acceptance: an empty bookmark generates the same SQL as before the
        // change. There is no first element to anchor on, so there is no
        // implied condition to add.
        const { query, feedCount } = feedSqlFor(ONE_OUTPUT, "");
        expect(feedCount).toBe(1);
        expect(query).not.toBeNull();
        expect(query!.sql).toEqual(
            "SELECT f2.hash as hash2, " +
            "sort(array[f2.fact_id], 'desc') as bookmark " +
            "FROM public.fact f1 " +
            "JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 " +
            "JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id " +
            "WHERE f1.fact_type_id = $1 AND f1.hash = $2 " +
            "AND sort(array[f2.fact_id], 'desc') > $4 " +
            "ORDER BY bookmark ASC LIMIT $5"
        );
        expect(query!.parameters).toEqual([
            1,
            site.hash,
            100,
            [],
            100
        ]);
    });

    it("anchors a single output fact on the bookmark's first element", () => {
        // The anchor names the edge column the output fact arrived on, not
        // `f2.fact_id`: an inequality on the fact's own primary key becomes an
        // index condition on a lookup that runs once per row the edge walk has
        // already produced, so it bounds nothing.
        const { query } = feedSqlFor(ONE_OUTPUT, "4321");
        expect(query).not.toBeNull();
        expect(query!.sql).toEqual(
            "SELECT * FROM (" +
            "SELECT f2.hash as hash2, " +
            "sort(array[f2.fact_id], 'desc') as bookmark " +
            "FROM public.fact f1 " +
            "JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 " +
            "JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id " +
            "WHERE f1.fact_type_id = $1 AND f1.hash = $2 " +
            "AND e1.successor_fact_id >= $6" +
            ") AS matches " +
            "WHERE bookmark > $4 " +
            "ORDER BY bookmark ASC LIMIT $5"
        );
        expect(query!.parameters).toEqual([
            1,
            site.hash,
            100,
            [4321],
            100,
            4321
        ]);
    });

    it("unions one branch per output fact", () => {
        // Two outputs means two branches, each anchoring a different fact on
        // the same parameter. An OR across the two would restrict neither.
        const { query } = feedSqlFor(TWO_OUTPUTS, "4321");
        expect(query).not.toBeNull();
        const body =
            "SELECT f2.hash as hash2, f3.hash as hash3, " +
            "sort(array[f2.fact_id, f3.fact_id], 'desc') as bookmark " +
            "FROM public.fact f1 " +
            "JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 " +
            "JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id " +
            "JOIN public.edge e2 ON e2.predecessor_fact_id = f2.fact_id AND e2.role_id = $4 " +
            "JOIN public.fact f3 ON f3.fact_id = e2.successor_fact_id " +
            "WHERE f1.fact_type_id = $1 AND f1.hash = $2";
        expect(query!.sql).toEqual(
            "SELECT * FROM (" +
            `${body} AND e1.successor_fact_id >= $7` +
            " UNION " +
            `${body} AND e2.successor_fact_id >= $7` +
            ") AS matches " +
            "WHERE bookmark > $5 " +
            "ORDER BY bookmark ASC LIMIT $6"
        );
        expect(query!.parameters).toEqual([
            1,
            site.hash,
            100,
            101,
            [4321],
            100,
            4321
        ]);
    });

    it("anchors on the bookmark's first element even when it is not the largest", () => {
        // The implication `b > B` implies `b[0] >= B[0]` is lexicographic, so
        // it holds whatever order the bookmark's elements arrive in. A client
        // that supplies an ascending bookmark still gets a correct anchor.
        const { query } = feedSqlFor(ONE_OUTPUT, "1234.4321");
        expect(query).not.toBeNull();
        expect(query!.sql).toContain("AND e1.successor_fact_id >= $6");
        expect(query!.parameters).toEqual([
            1,
            site.hash,
            100,
            [1234, 4321],
            100,
            1234
        ]);
    });

    it("anchors each output on the end of the edge that brought it in", () => {
        // An output reached by walking back from its successor is anchored on
        // `predecessor_fact_id`, which joins ix_successor's third column the way
        // `successor_fact_id` joins ix_predecessor's. Both directions appear in
        // this one feed, and the edge column, not the fact's key, is what an
        // index can serve.
        const { query, feedCount } = titleFeedSqlFor(BOTH_WALK_DIRECTIONS, "4321");
        expect(feedCount).toBe(1);
        expect(query).not.toBeNull();
        const body =
            "SELECT f2.hash as hash2, f3.hash as hash3, " +
            "sort(array[f2.fact_id, f3.fact_id], 'desc') as bookmark " +
            "FROM public.fact f1 " +
            "JOIN public.edge e1 ON e1.successor_fact_id = f1.fact_id AND e1.role_id = $3 " +
            "JOIN public.fact f2 ON f2.fact_id = e1.predecessor_fact_id " +
            "JOIN public.edge e2 ON e2.predecessor_fact_id = f2.fact_id AND e2.role_id = $4 " +
            "JOIN public.fact f3 ON f3.fact_id = e2.successor_fact_id " +
            "WHERE f1.fact_type_id = $1 AND f1.hash = $2";
        expect(query!.sql).toEqual(
            "SELECT * FROM (" +
            `${body} AND e1.predecessor_fact_id >= $7` +
            " UNION " +
            `${body} AND e2.successor_fact_id >= $7` +
            ") AS matches " +
            "WHERE bookmark > $5 " +
            "ORDER BY bookmark ASC LIMIT $6"
        );
        expect(query!.parameters).toEqual([
            1,
            titleGiven.hash,
            100,
            100,
            [4321],
            100,
            4321
        ]);
    });

    it("anchors an output that is a given on its own primary key", () => {
        // No edge brought the given into the query, so its branch falls back to
        // its fact_id. That branch gains nothing from an index — the given is
        // already pinned by hash — but it has to be there, because the implied
        // condition is a disjunction over every output fact and dropping one
        // branch would drop rows.
        const queries = feedSqlsFor(GIVEN_AS_OUTPUT, "4321");
        expect(queries.length).toBe(2);
        const body =
            "SELECT f2.hash as hash2, f1.hash as hash1, " +
            "sort(array[f2.fact_id, f1.fact_id], 'desc') as bookmark " +
            "FROM public.fact f1 " +
            "JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 " +
            "JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id " +
            "JOIN public.edge e2 ON e2.predecessor_fact_id = f1.fact_id " +
            "AND e2.successor_fact_id = f2.fact_id AND e2.role_id = $4 " +
            "WHERE f1.fact_type_id = $1 AND f1.hash = $2";
        expect(queries[0]).not.toBeNull();
        expect(queries[0]!.sql).toEqual(
            "SELECT * FROM (" +
            `${body} AND e1.successor_fact_id >= $7` +
            " UNION " +
            `${body} AND f1.fact_id >= $7` +
            ") AS matches " +
            "WHERE bookmark > $5 " +
            "ORDER BY bookmark ASC LIMIT $6"
        );
    });

    it("wraps the same query body the empty bookmark generates", () => {
        // Derived rather than restated: the expected SQL is built from the
        // generator's own empty-bookmark output, for every feed of every
        // specification in this file.
        const pairs = [
            ...[ONE_OUTPUT, TWO_OUTPUTS].map(specification => ({
                empty: [feedSqlFor(specification, "").query],
                paged: [feedSqlFor(specification, "4321").query]
            })),
            {
                empty: [titleFeedSqlFor(BOTH_WALK_DIRECTIONS, "").query],
                paged: [titleFeedSqlFor(BOTH_WALK_DIRECTIONS, "4321").query]
            },
            {
                empty: feedSqlsFor(GIVEN_AS_OUTPUT, ""),
                paged: feedSqlsFor(GIVEN_AS_OUTPUT, "4321")
            }
        ];
        for (const pair of pairs) {
            expect(pair.paged.length).toEqual(pair.empty.length);
            for (let f = 0; f < pair.empty.length; f++) {
                const empty = pair.empty[f];
                const paged = pair.paged[f];
                expect(empty).not.toBeNull();
                expect(paged).not.toBeNull();
                const outputFactIndexes = empty!.labels.map(label => label.index);
                expect(outputFactIndexes.length).toBeGreaterThan(0);
                expect(paged!.sql).toEqual(wrapEmptyBookmarkSql(
                    empty!.sql,
                    outputFactIndexes,
                    empty!.parameters.length));
                expect(paged!.labels).toEqual(empty!.labels);
            }
        }
    });
});
