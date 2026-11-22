import { buildFeeds, dehydrateReference, FactReference, getAllFactTypes, getAllRoles, Specification, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";
import { sqlFromFeed } from "../../src/postgres/specification-sql";

// Issue #235. A given that first appears inside an existential condition is an
// input of the condition, not of the query, so the enclosing scope has not
// written it. When the condition's first edge walked from that given, neither
// end of the edge was written and both builders threw `Neither predecessor nor
// successor fact has been written`. The same condition with its two path
// conditions in the other order reaches the given from a written fact and
// built, so reordering two path conditions that mean the same thing turned a
// well-formed specification into an error.

const site = dehydrateReference({ type: "Site", identifier: "TestSite" });
const parent = dehydrateReference({ type: "Comment", text: "Parent" });

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function mapsFor(specification: Specification): { factTypes: FactTypeMap, roleMap: RoleMap } {
    const factTypes = getAllFactTypes(specification).reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());
    const roleMap = getAllRoles(specification).reduce(
        (r, role, i) => addRole(r, getFactTypeId(factTypes, role.successorType)!, role.name, i + 1),
        emptyRoleMap());
    return { factTypes, roleMap };
}

// The given order of a feed is the feed's own, which `buildFeeds` is free to
// choose, so resolve each start reference from the label it is bound to rather
// than from a position.
function startFor(specification: Specification): FactReference[] {
    return specification.given.map(given => {
        if (given.label.type === "Site") {
            return site;
        }
        if (given.label.type === "Comment") {
            return parent;
        }
        throw new Error(`Unknown given type ${given.label.type}`);
    });
}

function readQueryFor(descriptiveString: string) {
    const specification = parseSpecification(descriptiveString);
    const maps = mapsFor(specification);
    const composer = resultSqlFromSpecification(startFor(specification), specification, maps.factTypes, maps.roleMap, "public");
    return { query: composer!.getSqlQueries().sqlQuery, ...maps };
}

function hasExistentialCondition(feed: Specification): boolean {
    return feed.matches.some(match => match.conditions.some(condition => condition.type === "existential"));
}

// Criterion 2 names the feed of the specification that KEEPS the existential
// condition. The other feed `buildFeeds` produces lifts the condition into a
// top-level match and belongs to #233, so select by the condition rather than
// by a position in the list.
function conditionBearingFeedQueryFor(descriptiveString: string) {
    const specification = parseSpecification(descriptiveString);
    const maps = mapsFor(specification);
    const feeds = buildFeeds(specification).filter(hasExistentialCondition);
    expect(feeds.length).toBe(1);
    const feed = feeds[0];
    const query = sqlFromFeed(feed, startFor(feed), "public", "", 100, maps.factTypes, maps.roleMap);
    return { query: query!, ...maps };
}

function typeId(factTypes: FactTypeMap, type: string): number {
    const id = getFactTypeId(factTypes, type);
    if (!id) {
        throw new Error(`Unknown fact type ${type}`);
    }
    return id;
}

function roleId(factTypes: FactTypeMap, roleMap: RoleMap, type: string, role: string): number {
    const id = getRoleId(roleMap, typeId(factTypes, type), role);
    if (!id) {
        throw new Error(`Unknown role ${role} of ${type}`);
    }
    return id;
}

function columns(factIndex: number): string {
    return `f${factIndex}.hash as hash${factIndex}, f${factIndex}.fact_id as id${factIndex}, ` +
        `f${factIndex}.data as data${factIndex}, f${factIndex}.date_learned as timestamp${factIndex}`;
}

// `site` is a given that only the condition uses. Written first, the condition
// walks `flag->site` from a fact no edge has reached.
function givenFirst(exists: string) {
    return `
        (site: Site, parent: Comment) {
            comment: Comment [
                comment->parent: Comment = parent
                ${exists} {
                    flag: Flag [
                        flag->site: Site = site
                        flag->comment: Comment = comment
                    ]
                }
            ]
        } => comment
    `;
}

// The same condition with the two path conditions swapped. The walk to
// `comment` reaches the condition's unknown from a written fact, so the tail
// join reaches `site`, and this form built before the fix.
function givenLast(exists: string) {
    return `
        (site: Site, parent: Comment) {
            comment: Comment [
                comment->parent: Comment = parent
                ${exists} {
                    flag: Flag [
                        flag->comment: Comment = comment
                        flag->site: Site = site
                    ]
                }
            ]
        } => comment
    `;
}

describe("Postgres read of a condition on a given only the condition uses", () => {
    it("brings the given in when the condition's first edge walks from it", () => {
        const { query, factTypes, roleMap } = readQueryFor(givenFirst("!E"));

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `CROSS JOIN public.fact f3 ` +
                `JOIN public.fact f4 ON f4.fact_id = e2.successor_fact_id ` +
                `JOIN public.edge e3 ON e3.predecessor_fact_id = f2.fact_id ` +
                    `AND e3.successor_fact_id = f4.fact_id AND e3.role_id = $7 ` +
                `WHERE e2.predecessor_fact_id = f3.fact_id AND e2.role_id = $6 ` +
                `AND f3.fact_type_id = $4 AND f3.hash = $5` +
            `) ` +
            `ORDER BY f2.fact_id ASC`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Comment"),
            parent.hash,
            roleId(factTypes, roleMap, "Comment", "parent"),
            typeId(factTypes, "Site"),
            site.hash,
            roleId(factTypes, roleMap, "Flag", "site"),
            roleId(factTypes, roleMap, "Flag", "comment")
        ]);
    });

    it("brings the given in for a positive condition too", () => {
        const { query } = readQueryFor(givenFirst("E"));

        expect(query.sql).toContain(
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `CROSS JOIN public.fact f3 ` +
                `JOIN public.fact f4 ON f4.fact_id = e2.successor_fact_id ` +
                `JOIN public.edge e3 ON e3.predecessor_fact_id = f2.fact_id ` +
                    `AND e3.successor_fact_id = f4.fact_id AND e3.role_id = $7 ` +
                `WHERE e2.predecessor_fact_id = f3.fact_id AND e2.role_id = $6 ` +
                `AND f3.fact_type_id = $4 AND f3.hash = $5` +
            `)`
        );
    });

    it("reaches the given through the tail join when the condition's first edge walks to the unknown", () => {
        const { query, factTypes, roleMap } = readQueryFor(givenLast("!E"));

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `JOIN public.fact f3 ON f3.fact_id = e2.successor_fact_id ` +
                `JOIN public.edge e3 ON e3.successor_fact_id = f3.fact_id AND e3.role_id = $7 ` +
                `JOIN public.fact f4 ON f4.fact_id = e3.predecessor_fact_id ` +
                `WHERE e2.predecessor_fact_id = f2.fact_id AND e2.role_id = $4 ` +
                `AND f4.fact_type_id = $5 AND f4.hash = $6` +
            `) ` +
            `ORDER BY f2.fact_id ASC`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Comment"),
            parent.hash,
            roleId(factTypes, roleMap, "Comment", "parent"),
            roleId(factTypes, roleMap, "Flag", "comment"),
            typeId(factTypes, "Site"),
            site.hash,
            roleId(factTypes, roleMap, "Flag", "site")
        ]);
    });
});

// The given is first used inside a condition NESTED in another one, so it is
// an input of the inner condition. Whichever condition first references a
// given records it as its own input, so the same helper has to be reached
// through the recursion, not only at the outermost condition.
const nestedGivenFirst = `
    (site: Site, parent: Comment) {
        comment: Comment [
            comment->parent: Comment = parent
            !E {
                flag: Flag [
                    flag->comment: Comment = comment
                    E {
                        tag: Tag [
                            tag->site: Site = site
                            tag->flag: Flag = flag
                        ]
                    }
                ]
            }
        ]
    } => comment
`;

describe("Postgres read of a condition nested inside another", () => {
    it("brings the given into the nested condition that is the first to use it", () => {
        const { query, factTypes, roleMap } = readQueryFor(nestedGivenFirst);

        expect(query.sql).toContain(
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e3 ` +
                `CROSS JOIN public.fact f4 ` +
                `JOIN public.fact f5 ON f5.fact_id = e3.successor_fact_id ` +
                `JOIN public.edge e4 ON e4.predecessor_fact_id = f3.fact_id ` +
                    `AND e4.successor_fact_id = f5.fact_id AND e4.role_id = $8 ` +
                `WHERE e3.predecessor_fact_id = f4.fact_id AND e3.role_id = $7 ` +
                `AND f4.fact_type_id = $5 AND f4.hash = $6` +
            `)`
        );
        expect(query.parameters[4]).toEqual(typeId(factTypes, "Site"));
        expect(query.parameters[5]).toEqual(site.hash);
        expect(query.parameters[6]).toEqual(roleId(factTypes, roleMap, "Tag", "site"));
    });
});

describe("Postgres feed of a condition on a given only the condition uses", () => {
    it("brings the given into the condition-bearing feed", () => {
        const { query, factTypes, roleMap } = conditionBearingFeedQueryFor(givenFirst("!E"));

        expect(query.sql).toEqual(
            `SELECT f2.hash as hash2, sort(array[f2.fact_id], 'desc') as bookmark ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `CROSS JOIN public.fact f3 ` +
                `JOIN public.fact f4 ON f4.fact_id = e2.successor_fact_id ` +
                `JOIN public.edge e3 ON e3.predecessor_fact_id = f2.fact_id ` +
                    `AND e3.successor_fact_id = f4.fact_id AND e3.role_id = $7 ` +
                `WHERE e2.predecessor_fact_id = f3.fact_id AND e2.role_id = $6 ` +
                `AND f3.fact_type_id = $4 AND f3.hash = $5` +
            `) ` +
            `AND sort(array[f2.fact_id], 'desc') > $8 ORDER BY bookmark ASC LIMIT $9`
        );
        expect(query.parameters.slice(0, 7)).toEqual([
            typeId(factTypes, "Comment"),
            parent.hash,
            roleId(factTypes, roleMap, "Comment", "parent"),
            typeId(factTypes, "Site"),
            site.hash,
            roleId(factTypes, roleMap, "Flag", "site"),
            roleId(factTypes, roleMap, "Flag", "comment")
        ]);
    });

    // `buildFeeds` keeps a NEGATIVE condition on the match it qualifies, and
    // lifts a POSITIVE one into a top-level match instead, so the positive
    // form has no condition-bearing feed to build. The read builder keeps the
    // positive condition and is covered above. This reads the feed list out of
    // the library rather than quoting that behavior: if a later `jinaga`
    // begins to keep a positive condition in a feed, this goes red, and the
    // feed it produces then needs the coverage above.
    it("produces no condition-bearing feed for a positive condition", () => {
        const feeds = buildFeeds(parseSpecification(givenFirst("E")));

        expect(feeds.filter(hasExistentialCondition)).toEqual([]);
        expect(feeds.length).toBe(1);
        // The one feed it does produce lifts the condition into a top-level
        // match that walks from the condition's given. #233 owns that shape.
        expect(feeds[0].matches.map(match => match.unknown.name)).toEqual(["comment", "flag"]);
    });
});
