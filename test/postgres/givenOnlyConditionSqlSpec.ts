import { buildFeeds, dehydrateReference, FactReference, getAllFactTypes, getAllRoles, Specification, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, RoleMap } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";
import { sqlFromFeed } from "../../src/postgres/specification-sql";

// Issue #264. jinaga/jinaga.js#434 removed the parser's rule that an
// existential condition must join its own unknown, so a condition may now
// correlate with nothing but a given of the enclosing query. The condition is
// then independent of the match it qualifies: `!E` keeps every item while no
// lock exists and none once one does. These tests run that shape through
// `buildFeeds` and both SQL builders and assert only that SQL is built, not
// what it says.

const root = dehydrateReference({ type: "Root", identifier: "TestRoot" });
const scope = dehydrateReference({ type: "Scope", identifier: "TestScope" });

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

// A feed's givens are in the order `buildFeeds` chooses, so resolve each start
// reference from its type rather than its position.
function startFor(specification: Specification): FactReference[] {
    return specification.given.map(given => {
        if (given.label.type === "Root") {
            return root;
        }
        if (given.label.type === "Scope") {
            return scope;
        }
        throw new Error(`Unknown given type ${given.label.type}`);
    });
}

function buildAll(descriptiveString: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = mapsFor(specification);

    const composer = resultSqlFromSpecification(startFor(specification), specification, factTypes, roleMap, "public");
    expect(composer).not.toBeNull();
    const read = composer!.getSqlQueries().sqlQuery;
    expect(read.sql).toBeTruthy();

    const feeds = buildFeeds(specification);
    expect(feeds.length).toBeGreaterThan(0);
    const feedQueries = feeds.map(feed => sqlFromFeed(feed, startFor(feed), "public", "", 100, factTypes, roleMap));
    feedQueries.forEach(query => {
        expect(query).not.toBeNull();
        expect(query!.sql).toBeTruthy();
    });
}

// The condition joins only `r`, the query's first given.
function oneGiven(exists: string) {
    return `
        (r: Root) {
            b: Item [
                b->root: Root = r
                ${exists} {
                    a: Lock [
                        a->root: Root = r
                    ]
                }
            ]
        } => b
    `;
}

// The condition joins only `s`, the given that is not the query's first fact.
// `b` reaches `s` too, because a given the specification reaches only inside
// the condition leaves two disconnected chains, which the parser refuses (see
// the last test).
function twoGivens(exists: string) {
    return `
        (r: Root, s: Scope) {
            b: Item [
                b->root: Root = r
                b->scope: Scope = s
                ${exists} {
                    a: Lock [
                        a->scope: Scope = s
                    ]
                }
            ]
        } => b
    `;
}

describe("Postgres SQL for a condition that joins only a given", () => {
    it("parses a negative condition on the query's only given", () => {
        expect(() => parseSpecification(oneGiven("!E"))).not.toThrow();
    });

    it("builds SQL for a negative condition on the query's only given", () => {
        buildAll(oneGiven("!E"));
    });

    it("builds SQL for a positive condition on the query's only given", () => {
        buildAll(oneGiven("E"));
    });

    it("builds SQL for a negative condition on the second of two givens", () => {
        buildAll(twoGivens("!E"));
    });

    it("builds SQL for a positive condition on the second of two givens", () => {
        buildAll(twoGivens("E"));
    });

    // jinaga reads `r` and `s` as two disconnected chains when only the
    // condition reaches `s`, and refuses the specification before this server
    // sees it. This reads that rule out of the library rather than quoting
    // it: if a later `jinaga` accepts the shape, this goes red, and the shape
    // then needs the coverage above.
    it("is refused by the parser when only the condition reaches the second given", () => {
        expect(() => parseSpecification(`
            (r: Root, s: Scope) {
                b: Item [
                    b->root: Root = r
                    !E {
                        a: Lock [
                            a->scope: Scope = s
                        ]
                    }
                ]
            } => b
        `)).toThrow(/Disconnected specification/);
    });
});
