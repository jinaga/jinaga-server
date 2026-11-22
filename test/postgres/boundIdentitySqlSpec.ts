import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";
import { sqlFromSpecification } from "../../src/postgres/specification-sql";
import { purgeSqlFromSpecification } from "../../src/postgres/purge-sql";

// Issue #229. An identity condition between two labels that are both already
// bound carries no role, so neither role walk emits an edge to tie its two
// sides together. Written last the condition was dropped, which widened the
// read; written first it bound the condition's own unknown to a fact the
// enclosing scope had already written, which left the first edge joining two
// written facts and threw `Not yet implemented`.
//
// Issue #231. Writing the identity last still allocated the unknown a fact of
// its own and then pinned it to the other side, so the two orders of one
// condition produced different SQL. The unknown is now substituted away, and
// each shape below pins one SQL string that both orders generate.

const company = dehydrateReference({ type: "Company", identifier: "TestCompany" });
const office = dehydrateReference({ type: "Office", company: company, identifier: "TestOffice" });

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function mapsFor(descriptiveString: string): { factTypes: FactTypeMap, roleMap: RoleMap } {
    const specification = parseSpecification(descriptiveString);
    const factTypes = getAllFactTypes(specification).reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());
    const roleMap = getAllRoles(specification).reduce(
        (r, role, i) => addRole(r, getFactTypeId(factTypes, role.successorType)!, role.name, i + 1),
        emptyRoleMap());
    return { factTypes, roleMap };
}

function startFor(specification: { given: { label: { type: string } }[] }) {
    return specification.given.map(given => {
        if (given.label.type === "Office") {
            return office;
        }
        if (given.label.type === "Company") {
            return company;
        }
        throw new Error(`Unknown given type ${given.label.type}`);
    });
}

function readQueryFor(descriptiveString: string) {
    const maps = mapsFor(descriptiveString);
    const specification = parseSpecification(descriptiveString);
    const composer = resultSqlFromSpecification(startFor(specification), specification, maps.factTypes, maps.roleMap, "public");
    return { query: composer!.getSqlQueries().sqlQuery, ...maps };
}

function feedQueriesFor(descriptiveString: string) {
    const maps = mapsFor(descriptiveString);
    const specification = parseSpecification(descriptiveString);
    const queries = sqlFromSpecification(
        startFor(specification),
        "public",
        specification.given.map(() => ""),
        100,
        specification,
        maps.factTypes,
        maps.roleMap);
    return { queries, ...maps };
}

function purgeCommandFor(descriptiveString: string) {
    const maps = mapsFor(descriptiveString);
    const specification = parseSpecification(descriptiveString);
    return purgeSqlFromSpecification(specification, maps.factTypes, maps.roleMap, "public");
}

// The SQL and its parameters are the observable result of a query
// description, so comparing two orders of one condition compares these.
function readSqlFor(descriptiveString: string) {
    const { query } = readQueryFor(descriptiveString);
    return { sql: query.sql, parameters: query.parameters };
}

function feedSqlFor(descriptiveString: string) {
    const { queries } = feedQueriesFor(descriptiveString);
    return queries.map(query => ({ sql: query.sql, parameters: query.parameters }));
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

// The condition of #229, on a given. `o` is bound by its walk from `company`,
// and `office` is bound as a given, so `o = office` brings together two facts
// that the query has already written.
const identityLastOnGiven = `
    (office: Office, company: Company [
        E {
            o: Office [
                o->company: Company = company
                o = office
            ]
        }
    ]) {
    } => office
`;

// The same condition, with the identity written first. `o = office` makes `o`
// an alias of the given's own fact index, so the walk to `company` emits an
// edge between two facts the query has already written.
const identityFirstOnGiven = `
    (office: Office, company: Company [
        E {
            o: Office [
                o = office
                o->company: Company = company
            ]
        }
    ]) {
    } => office
`;

// The same condition inside a positive condition on a match. `buildFeeds`
// lifts a positive condition into the feed's own matches, so this pair of
// specifications exercises the read shape and the feed shape.
const identityLastOnMatch = `
    (office: Office, company: Company) {
        president: President [
            president->office: Office = office
            E {
                o: Office [
                    o = president->office: Office
                    o = office
                ]
            }
        ]
    } => president
`;

const identityFirstOnMatch = `
    (office: Office, company: Company) {
        president: President [
            president->office: Office = office
            E {
                o: Office [
                    o = office
                    o = president->office: Office
                ]
            }
        ]
    } => president
`;

// A purge condition with a self-referential role: an office that is its own
// parent. Purge binds a given only when a condition first names it, so a
// prototype that reordered the conditions of a match left this shape behind.
const identityLastInPurge = `
    (office: Office) {
        o: Office [
            o->parent: Office = office
            o = office
        ]
    }
`;

const identityFirstInPurge = `
    (office: Office) {
        o: Office [
            o = office
            o->parent: Office = office
        ]
    }
`;

describe("Postgres read of an identity between two bound labels", () => {
    it("correlates the first edge on both facts, for a condition on a given", () => {
        const { query, factTypes, roleMap } = readQueryFor(identityFirstOnGiven);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `CROSS JOIN public.fact f2 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f2.fact_type_id = $3 AND f2.hash = $4 ` +
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e1 ` +
                `WHERE e1.predecessor_fact_id = f2.fact_id ` +
                `AND e1.successor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $5` +
            `)`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            typeId(factTypes, "Company"),
            company.hash,
            roleId(factTypes, roleMap, "Office", "company")
        ]);
    });

    it("generates the same read for a condition on a given written either way", () => {
        expect(readSqlFor(identityLastOnGiven)).toEqual(readSqlFor(identityFirstOnGiven));
    });

    it("correlates the first edge on both facts, inside a positive condition on a match", () => {
        const { query, factTypes, roleMap } = readQueryFor(identityFirstOnMatch);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `WHERE e2.predecessor_fact_id = f1.fact_id ` +
                `AND e2.successor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4` +
            `) ` +
            `ORDER BY f2.fact_id ASC`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            roleId(factTypes, roleMap, "President", "office"),
            roleId(factTypes, roleMap, "President", "office")
        ]);
    });

    it("generates the same read for a positive condition on a match written either way", () => {
        expect(readSqlFor(identityLastOnMatch)).toEqual(readSqlFor(identityFirstOnMatch));
    });

    it("correlates the first edge on both facts inside a negative condition on a match", () => {
        const { query } = readQueryFor(`
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
            } => president
        `);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `WHERE e2.predecessor_fact_id = f1.fact_id ` +
                `AND e2.successor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4` +
            `) ` +
            `ORDER BY f2.fact_id ASC`
        );
    });

    // A given that unifies with a match's own unknown shares that fact index,
    // so the identity holds trivially and adds no clause. The duplicated
    // columns are the pre-existing effect of `inputs` and `outputs` sharing an
    // index, which issue #229 puts out of scope.
    it("adds no clause when both labels are bound to the same fact", () => {
        const { query } = readQueryFor(`
            (office: Office, company: Company) {
                o: Office [
                    o->company: Company = company
                    o = office
                ]
            } => o
        `);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f2.fact_type_id = $4 AND f2.hash = $5 ` +
            `ORDER BY f2.fact_id ASC`
        );
    });

    // Both labels of this identity are givens, bound before the match begins.
    // Neither is the match's own unknown, so there is no surplus variable to
    // substitute away: the condition is a constraint between two facts, and it
    // is compared in the scope where it appears.
    it("compares two facts that both come from outside the match", () => {
        const { query, factTypes, roleMap } = readQueryFor(`
            (office: Office, other: Office, company: Company [
                E {
                    o: Office [
                        o = office
                        o = other
                        o->company: Company = company
                    ]
                }
            ]) {
            } => office
        `);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)}, ${columns(3)} ` +
            `FROM public.fact f1 ` +
            `CROSS JOIN public.fact f2 ` +
            `CROSS JOIN public.fact f3 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f2.fact_type_id = $3 AND f2.hash = $4 ` +
                `AND f3.fact_type_id = $5 AND f3.hash = $6 ` +
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e1 ` +
                `WHERE e1.predecessor_fact_id = f3.fact_id ` +
                `AND e1.successor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $7 ` +
                `AND f1.fact_id = f2.fact_id` +
            `)`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            typeId(factTypes, "Office"),
            office.hash,
            typeId(factTypes, "Company"),
            company.hash,
            roleId(factTypes, roleMap, "Office", "company")
        ]);
    });
});

// `buildFeeds` lifts a positive existential condition into the feed's own
// matches, so an identity recorded inside one lands among the feed's joins
// rather than in a subquery.
describe("Feed of an identity between two bound labels", () => {
    it("correlates the first edge on both facts, for a positive condition", () => {
        const { queries, factTypes, roleMap } = feedQueriesFor(identityFirstOnMatch);

        expect(queries.length).toEqual(1);
        expect(queries[0].sql).toEqual(
            `SELECT f2.hash as hash2, f1.hash as hash1, ` +
                `sort(array[f2.fact_id, f1.fact_id], 'desc') as bookmark ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `JOIN public.edge e2 ON e2.predecessor_fact_id = f1.fact_id ` +
                `AND e2.successor_fact_id = f2.fact_id AND e2.role_id = $4 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND sort(array[f2.fact_id, f1.fact_id], 'desc') > $5 ` +
            `ORDER BY bookmark ASC LIMIT $6`
        );
        expect(queries[0].parameters.slice(0, 4)).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            roleId(factTypes, roleMap, "President", "office"),
            roleId(factTypes, roleMap, "President", "office")
        ]);
    });

    it("generates the same feed for a positive condition written either way", () => {
        expect(feedSqlFor(identityLastOnMatch)).toEqual(feedSqlFor(identityFirstOnMatch));
    });

    it("correlates the first edge on both facts, for a negative condition", () => {
        const { queries } = feedQueriesFor(`
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
            } => president
        `);

        // One feed joins the condition's facts, and one applies it as a
        // negative subquery. Both correlate the edge on two written facts.
        expect(queries.length).toEqual(2);
        expect(queries[0].sql).toEqual(
            `SELECT f2.hash as hash2, f1.hash as hash1, ` +
                `sort(array[f2.fact_id, f1.fact_id], 'desc') as bookmark ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `JOIN public.edge e2 ON e2.predecessor_fact_id = f1.fact_id ` +
                `AND e2.successor_fact_id = f2.fact_id AND e2.role_id = $4 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND sort(array[f2.fact_id, f1.fact_id], 'desc') > $5 ` +
            `ORDER BY bookmark ASC LIMIT $6`
        );
        expect(queries[1].sql).toEqual(
            `SELECT f2.hash as hash2, sort(array[f2.fact_id], 'desc') as bookmark ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e2 ` +
                `WHERE e2.predecessor_fact_id = f1.fact_id ` +
                `AND e2.successor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4` +
            `) ` +
            `AND sort(array[f2.fact_id], 'desc') > $5 ` +
            `ORDER BY bookmark ASC LIMIT $6`
        );
    });
});

// Purge builds its query description through the same
// `QueryDescriptionBuilder.addEdges`, so a purge condition carrying this shape
// goes through the same substitution. The role is self-referential, so the
// candidates clause joins the fact to itself: an office that is its own
// parent, rather than an office that merely has a child.
describe("Purge of an identity between two bound labels", () => {
    it("joins the fact to itself in the candidates clause", () => {
        const purgeCommand = purgeCommandFor(identityFirstInPurge);

        expect(purgeCommand).not.toBeNull();
        expect(purgeCommand!.sql).toContain(
            `    FROM public.fact f1\n` +
            `    JOIN public.edge e1\n` +
            `        ON e1.predecessor_fact_id = f1.fact_id\n` +
            `        AND e1.successor_fact_id = f1.fact_id\n` +
            `        AND e1.role_id = $2\n` +
            `    WHERE f1.fact_type_id = $1\n`
        );
    });

    it("generates the same purge for either order of the condition", () => {
        expect(purgeCommandFor(identityLastInPurge)).toEqual(purgeCommandFor(identityFirstInPurge));
    });
});
