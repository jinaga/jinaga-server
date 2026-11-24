import { buildFeeds, dehydrateFact, dehydrateReference, FactRecord, getAllFactTypes, getAllRoles, Invalid, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "../../src/postgres/maps";
import { ResultSetFact, ResultSetRow, ResultSetTree, resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";
import { sqlFromFeed } from "../../src/postgres/specification-sql";

// Issue #233. Both SQL builders seeded the FROM clause with the one given that
// the first edge touches, then walked the edges in order. A later match that
// walks from a second given gave `generateJoins` an edge with neither end
// written, and it threw "Neither predecessor nor successor fact has been
// written". Each given is pinned by type and hash in the WHERE clause, so an
// unreached given is brought into the FROM clause with a CROSS JOIN at the
// point an edge first needs it.

const r1 = dehydrateReference({ type: "R", identifier: "r1" });
const a1 = dehydrateReference({ type: "A", identifier: "a1" });

// Specification J: two givens, each reached by its own chain, joined by the
// last match. Written exactly as issue #233 states it.
const J = `
    (p1: R, p2: A) {
        u: A [
            u->a: A = p2
        ]
        c: A [
            c->r: R = p1
        ]
        x: B [
            x->c: A = c
            x->u: A = u
        ]
    } => x
`;

// Specification P: a child feed that is the product of two chains, with no
// match joining them yet. Written exactly as issue #233 states it.
const P = `
    (p1: R, p2: A) {
        u: A [
            u->a: A = p2
        ]
    } => {
        k = {
            c: A [
                c->r: R = p1
            ]
        } => {
            g = {
                x: B [
                    x->c: A = c
                    x->u: A = u
                ]
            } => x
        }
    }
`;

// Specification Q. P's child inherited `u` and reached only `p1`, so nothing
// joined the two chains and jinaga now refuses it. Q is the nearest shape that
// is still well formed: its child joins its parent's label `u` and *also*
// reaches `p1`, a given the parent never reached. That still makes the child
// allocate a new input, and a new input lands among the inputs rather than
// after them, which is the case the `ResultComposer` addressing issue #233
// introduced exists to serve. Issue #251.
const Q = `
    (p1: R, p2: A) {
        u: A [
            u->a: A = p2
        ]
    } => {
        k = {
            c: A [
                c->u: A = u
                c->r: R = p1
            ]
        } => c
    }
`;

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

// A specification the parser refuses, and the error it refused it with.
function captureParseError(input: string): Error {
    try {
        parseSpecification(input);
    } catch (error) {
        return error as Error;
    }
    throw new Error("Expected the parser to refuse the specification, but it accepted it.");
}

function mapsFor(descriptiveString: string): { factTypes: FactTypeMap, roleMap: RoleMap } {
    const specification = parseSpecification(descriptiveString);
    const factTypes = getAllFactTypes(specification).reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());
    const roleMap = getAllRoles(specification).reduce(
        (rm, role, i) => addRole(rm, getFactTypeId(factTypes, role.successorType)!, role.name, i + 1),
        emptyRoleMap());
    return { factTypes, roleMap };
}

function referenceFor(type: string) {
    if (type === "R") {
        return r1;
    }
    if (type === "A") {
        return a1;
    }
    throw new Error(`Unknown given type ${type}`);
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

// The FROM clause runs from "FROM " to the WHERE that follows it. Every fact
// the query selects from is declared there once, whether it arrives on a JOIN
// or on a CROSS JOIN, and Postgres rejects a clause that declares one alias
// twice.
function factAliasesInFromClause(sql: string): string[] {
    const fromClause = /\bFROM (.*?) WHERE /.exec(sql);
    if (!fromClause) {
        throw new Error(`No FROM ... WHERE in ${sql}`);
    }
    return Array.from(fromClause[1].matchAll(/\bpublic\.fact (f\d+)\b/g))
        .map(match => match[1]);
}

// Every alias the query mentions anywhere has to be declared in its FROM
// clause, or Postgres cannot resolve it. Deriving the expected set from the
// whole statement means a join the builder forgets to emit fails this, not
// just a pinned string that someone later updates.
function factAliasesReferenced(sql: string): string[] {
    const aliases = new Set(Array.from(sql.matchAll(/\b(f\d+)\.\w+/g)).map(match => match[1]));
    return Array.from(aliases).sort();
}

function expectEveryAliasDeclaredOnce(sql: string) {
    const declared = factAliasesInFromClause(sql);
    expect(Array.from(new Set(declared)).sort()).toEqual(declared.slice().sort());
    expect(declared.slice().sort()).toEqual(factAliasesReferenced(sql));
}

function feedsFor(descriptiveString: string) {
    const specification = parseSpecification(descriptiveString);
    const maps = mapsFor(descriptiveString);
    const feeds = buildFeeds(specification);
    const queries = feeds.map(feed => {
        const start = feed.given.map(given => {
            const original = specification.given.find(g => g.label.name === given.label.name);
            if (!original) {
                throw new Error(`Feed given ${given.label.name} is not a given of the specification`);
            }
            return referenceFor(original.label.type);
        });
        return sqlFromFeed(feed, start, "public", "", 100, maps.factTypes, maps.roleMap);
    });
    return { queries, ...maps };
}

function readFor(descriptiveString: string) {
    const specification = parseSpecification(descriptiveString);
    const maps = mapsFor(descriptiveString);
    const start = specification.given.map(given => referenceFor(given.label.type));
    const composer = resultSqlFromSpecification(start, specification, maps.factTypes, maps.roleMap, "public");
    return { composer, ...maps };
}

// Rows as the composer receives them from Postgres, built here instead of read
// from a database. `main.yml` does not run the integration suite, so the
// grouping these rows exercise would otherwise be covered only there.
const rootFact = { type: "R", identifier: "r1" };
const anchorFact = { type: "A", identifier: "a1" };

class Graph {
    public readonly factRecords: FactRecord[] = [];

    // One row column: the fact at a label, with the fact id that the
    // composer's identifiers are made of.
    public at(fact: {}, factId: number): ResultSetFact {
        const records = dehydrateFact(fact);
        for (const record of records) {
            if (!this.factRecords.some(known =>
                known.type === record.type && known.hash === record.hash)) {
                this.factRecords.push(record);
            }
        }
        const reference = dehydrateReference(fact);
        const record = records.find(candidate =>
            candidate.type === reference.type && candidate.hash === reference.hash)!;
        return {
            hash: record.hash,
            factId,
            data: { fields: record.fields, predecessors: record.predecessors },
            timestamp: new Date(0)
        };
    }
}

function factIndexOf(labels: { name: string, index: number }[], name: string): number {
    const label = labels.find(candidate => candidate.name === name);
    if (!label) {
        throw new Error(`No label named ${name} in ${labels.map(l => l.name).join(", ")}`);
    }
    return label.index;
}

function row(columns: { [factIndex: number]: ResultSetFact }): ResultSetRow {
    return columns;
}

describe("Postgres SQL for a specification that walks from a second given", () => {
    describe("specification J, read", () => {
        it("brings the unreached given in with a CROSS JOIN", () => {
            const { composer, factTypes, roleMap } = readFor(J);

            const query = composer!.getSqlQueries().sqlQuery;

            expect(query.sql).toEqual(
                "SELECT f1.hash as hash1, f1.fact_id as id1, f1.data as data1, f1.date_learned as timestamp1, " +
                "f3.hash as hash3, f3.fact_id as id3, f3.data as data3, f3.date_learned as timestamp3, " +
                "f2.hash as hash2, f2.fact_id as id2, f2.data as data2, f2.date_learned as timestamp2, " +
                "f4.hash as hash4, f4.fact_id as id4, f4.data as data4, f4.date_learned as timestamp4, " +
                "f5.hash as hash5, f5.fact_id as id5, f5.data as data5, f5.date_learned as timestamp5 " +
                "FROM public.fact f1" +
                " JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3" +
                " JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id" +
                " CROSS JOIN public.fact f3" +
                " JOIN public.edge e2 ON e2.predecessor_fact_id = f3.fact_id AND e2.role_id = $6" +
                " JOIN public.fact f4 ON f4.fact_id = e2.successor_fact_id" +
                " JOIN public.edge e3 ON e3.predecessor_fact_id = f4.fact_id AND e3.role_id = $7" +
                " JOIN public.fact f5 ON f5.fact_id = e3.successor_fact_id" +
                " JOIN public.edge e4 ON e4.predecessor_fact_id = f2.fact_id AND e4.successor_fact_id = f5.fact_id AND e4.role_id = $8" +
                " WHERE f1.fact_type_id = $1 AND f1.hash = $2 AND f3.fact_type_id = $4 AND f3.hash = $5" +
                " ORDER BY f2.fact_id ASC, f4.fact_id ASC, f5.fact_id ASC");
            expect(query.parameters).toEqual([
                typeId(factTypes, "A"), a1.hash,
                roleId(factTypes, roleMap, "A", "a"),
                typeId(factTypes, "R"), r1.hash,
                roleId(factTypes, roleMap, "A", "r"),
                roleId(factTypes, roleMap, "B", "c"),
                roleId(factTypes, roleMap, "B", "u")
            ]);
        });

        it("declares every fact alias in the FROM clause exactly once", () => {
            const { composer } = readFor(J);

            expectEveryAliasDeclaredOnce(composer!.getSqlQueries().sqlQuery.sql);
        });

        it("requires the result to succeed a c of p1 and a u of p2", () => {
            const { composer } = readFor(J);

            const sql = composer!.getSqlQueries().sqlQuery.sql;

            // f5 is x. It reaches p1 through f4, the c of p1, and it reaches
            // p2 through f2, the u of p2. An x that succeeds only one of the
            // two satisfies neither join, so no such row is returned.
            expect(sql).toContain("JOIN public.edge e3 ON e3.predecessor_fact_id = f4.fact_id");
            expect(sql).toContain("JOIN public.fact f5 ON f5.fact_id = e3.successor_fact_id");
            expect(sql).toContain("e4.predecessor_fact_id = f2.fact_id AND e4.successor_fact_id = f5.fact_id");
        });
    });

    describe("specification J, feed", () => {
        it("generates one query that brings the unreached given in with a CROSS JOIN", () => {
            const { queries, factTypes, roleMap } = feedsFor(J);

            expect(queries.length).toBe(1);
            expect(queries[0]!.sql).toEqual(
                "SELECT f2.hash as hash2, f4.hash as hash4, f5.hash as hash5, " +
                "sort(array[f2.fact_id, f4.fact_id, f5.fact_id], 'desc') as bookmark " +
                "FROM public.fact f1" +
                " JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3" +
                " JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id" +
                " CROSS JOIN public.fact f3" +
                " JOIN public.edge e2 ON e2.predecessor_fact_id = f3.fact_id AND e2.role_id = $6" +
                " JOIN public.fact f4 ON f4.fact_id = e2.successor_fact_id" +
                " JOIN public.edge e3 ON e3.predecessor_fact_id = f4.fact_id AND e3.role_id = $7" +
                " JOIN public.fact f5 ON f5.fact_id = e3.successor_fact_id" +
                " JOIN public.edge e4 ON e4.predecessor_fact_id = f2.fact_id AND e4.successor_fact_id = f5.fact_id AND e4.role_id = $8" +
                " WHERE f1.fact_type_id = $1 AND f1.hash = $2 AND f3.fact_type_id = $4 AND f3.hash = $5" +
                " AND sort(array[f2.fact_id, f4.fact_id, f5.fact_id], 'desc') > $9" +
                " ORDER BY bookmark ASC LIMIT $10");
            expect(queries[0]!.parameters).toEqual([
                typeId(factTypes, "A"), a1.hash,
                roleId(factTypes, roleMap, "A", "a"),
                typeId(factTypes, "R"), r1.hash,
                roleId(factTypes, roleMap, "A", "r"),
                roleId(factTypes, roleMap, "B", "c"),
                roleId(factTypes, roleMap, "B", "u"),
                [],
                100
            ]);
        });

        it("declares every fact alias in the FROM clause exactly once", () => {
            const { queries } = feedsFor(J);

            expectEveryAliasDeclaredOnce(queries[0]!.sql);
        });
    });

    // Specification P was written for issue #233 to pin what the builders do
    // with a child feed that is the product of two chains: both of them cross
    // joined p1 into that feed and generated the product, and these tests
    // asserted the SQL for it.
    //
    // jinaga 6.17.0 (jinaga/jinaga.js#436), taken in issue #250, refuses such
    // a specification in the parser, so neither builder receives it any more
    // and there is no generated SQL left to assert. P's top-level and
    // grandchild feeds were connected; it is the child feed, which inherits
    // only `u` and adds `c`, that is the product, and the message says so.
    //
    // What is still true of this repository, and worth holding, is that the
    // refusal arrives before any SQL is generated. The same guarantee is held
    // at the HTTP boundary by test/http/disconnectedSpecificationSpec.ts.
    // Specification J above is unaffected and still covers the CROSS JOIN that
    // issue #233 added, for a second given that an edge does reach.
    describe("specification P", () => {
        it("is refused for its child feed, naming that scope and both chains", () => {
            const error = captureParseError(P);

            expect(error.message).toContain("Subgraph 1: ['u:A', 'p2:A']");
            expect(error.message).toContain("Subgraph 2: ['c:A', 'p1:R']");
            expect(error.message).toContain(
                "a child specification of the projection would be the product of 2 chains");
        });

        // The refusal is an Invalid, so a request carrying P is a client error
        // rather than the 500 a throw from the builders produced.
        it("raises the refusal as an Invalid", () => {
            expect(captureParseError(P)).toBeInstanceOf(Invalid);
        });
    });

    // Issue #251. These replace what specification P held for the read path:
    // a child query whose label list is not its parent's with extra columns
    // appended. `ResultComposer` groups each child row under the parent row
    // whose identifier it matches, and it reads that identifier out of the
    // child row by the parent's fact indexes. Taking it to be the child's
    // leading columns instead would read p1 where `u` belongs.
    describe("specification Q, feeds", () => {
        it("generates a query for the top level and for the child", () => {
            const { queries } = feedsFor(Q);

            expect(queries.length).toBe(2);
            expect(queries.every(query => query !== null)).toBe(true);
        });

        it("reaches p2 alone in the top-level feed", () => {
            const { queries, factTypes, roleMap } = feedsFor(Q);

            expect(queries[0]!.sql).toEqual(
                "SELECT f2.hash as hash2, sort(array[f2.fact_id], 'desc') as bookmark " +
                "FROM public.fact f1" +
                " JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3" +
                " JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id" +
                " WHERE f1.fact_type_id = $1 AND f1.hash = $2" +
                " AND sort(array[f2.fact_id], 'desc') > $4" +
                " ORDER BY bookmark ASC LIMIT $5");
            expect(queries[0]!.parameters).toEqual([
                typeId(factTypes, "A"), a1.hash,
                roleId(factTypes, roleMap, "A", "a"),
                [],
                100
            ]);
        });

        it("reaches p1 in the child feed, which the top level never reached", () => {
            const { queries, factTypes, roleMap } = feedsFor(Q);

            // The child's own edge walks from `c` back to p1, so p1 arrives on
            // an ordinary join from a written successor and needs no CROSS
            // JOIN. It is pinned by type and hash all the same, which is what
            // makes it an input of this query and not an output.
            expect(queries[1]!.sql).toEqual(
                "SELECT f2.hash as hash2, f3.hash as hash3, " +
                "sort(array[f2.fact_id, f3.fact_id], 'desc') as bookmark " +
                "FROM public.fact f1" +
                " JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3" +
                " JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id" +
                " JOIN public.edge e2 ON e2.predecessor_fact_id = f2.fact_id AND e2.role_id = $4" +
                " JOIN public.fact f3 ON f3.fact_id = e2.successor_fact_id" +
                " JOIN public.edge e3 ON e3.successor_fact_id = f3.fact_id AND e3.role_id = $7" +
                " JOIN public.fact f4 ON f4.fact_id = e3.predecessor_fact_id" +
                " WHERE f1.fact_type_id = $1 AND f1.hash = $2 AND f4.fact_type_id = $5 AND f4.hash = $6" +
                " AND sort(array[f2.fact_id, f3.fact_id], 'desc') > $8" +
                " ORDER BY bookmark ASC LIMIT $9");
            expect(queries[1]!.parameters).toEqual([
                typeId(factTypes, "A"), a1.hash,
                roleId(factTypes, roleMap, "A", "a"),
                roleId(factTypes, roleMap, "A", "u"),
                typeId(factTypes, "R"), r1.hash,
                roleId(factTypes, roleMap, "A", "r"),
                [],
                100
            ]);
        });

        it("declares every fact alias in the FROM clause of every feed exactly once", () => {
            const { queries } = feedsFor(Q);

            queries.forEach(query => expectEveryAliasDeclaredOnce(query!.sql));
        });
    });

    describe("specification Q, read", () => {
        it("generates a query for the top level and one for the child projection", () => {
            const { composer } = readFor(Q);

            const tree = composer!.getSqlQueries();

            expect(tree.childQueries.length).toBe(1);
            expect(tree.childQueries[0].name).toBe("k");
        });

        // The labels of a query, in the order its identifier reads them:
        // inputs first, then outputs. p1 is an input of the child and not of
        // the parent, so it sorts ahead of the parent's output `u`. A composer
        // that read its parent's identifier off the child's leading columns
        // would take p2 and p1 for p2 and `u`, and p1 is fixed by hash in
        // every row — so every child row would group under one parent row.
        it("allocates the given the parent did not reach among the child's inputs", () => {
            const { composer } = readFor(Q);

            const tree = composer!.getSqlQueries();

            expect(tree.sqlQuery.labels.map(label => label.name)).toEqual(["p2", "u"]);
            expect(tree.childQueries[0].sqlQuery.labels.map(label => label.name))
                .toEqual(["p2", "p1", "u", "c"]);
        });

        it("declares every fact alias in the FROM clause of every nested query exactly once", () => {
            const { composer } = readFor(Q);

            const tree = composer!.getSqlQueries();

            expectEveryAliasDeclaredOnce(tree.sqlQuery.sql);
            expectEveryAliasDeclaredOnce(tree.childQueries[0].sqlQuery.sql);
        });

        // The addressing itself, rather than the label order it rests on. Two
        // `u` of p2, with two `c` under the first and one under the second.
        // Reading the parent's identifier off the child's leading columns
        // would take p2 and p1 for p2 and `u`; p1 is fixed by hash, so every
        // child row would carry the same pair and all three `c` would group
        // under the first `u`, leaving the second empty.
        it("groups each child row under the parent row it belongs to", () => {
            const { composer } = readFor(Q);
            const queries = composer!.getSqlQueries();
            const parentLabels = queries.sqlQuery.labels;
            const childLabels = queries.childQueries[0].sqlQuery.labels;

            const p2Parent = factIndexOf(parentLabels, "p2");
            const uParent = factIndexOf(parentLabels, "u");
            const p2Child = factIndexOf(childLabels, "p2");
            const p1Child = factIndexOf(childLabels, "p1");
            const uChild = factIndexOf(childLabels, "u");
            const cChild = factIndexOf(childLabels, "c");

            const graph = new Graph();
            const u1 = { type: "A", a: anchorFact, identifier: "u1" };
            const u2 = { type: "A", a: anchorFact, identifier: "u2" };
            const anchor = graph.at(anchorFact, 10);
            const root = graph.at(rootFact, 11);
            const firstU = graph.at(u1, 21);
            const secondU = graph.at(u2, 22);

            const resultSets: ResultSetTree = {
                resultSet: [
                    row({ [p2Parent]: anchor, [uParent]: firstU }),
                    row({ [p2Parent]: anchor, [uParent]: secondU })
                ],
                childResultSets: [{
                    name: "k",
                    resultSet: [
                        row({
                            [p2Child]: anchor, [p1Child]: root, [uChild]: firstU,
                            [cChild]: graph.at({ type: "A", u: u1, r: rootFact, identifier: "c1" }, 31)
                        }),
                        row({
                            [p2Child]: anchor, [p1Child]: root, [uChild]: firstU,
                            [cChild]: graph.at({ type: "A", u: u1, r: rootFact, identifier: "c2" }, 32)
                        }),
                        row({
                            [p2Child]: anchor, [p1Child]: root, [uChild]: secondU,
                            [cChild]: graph.at({ type: "A", u: u2, r: rootFact, identifier: "c3" }, 33)
                        })
                    ],
                    childResultSets: []
                }]
            };

            const results = composer!.compose(resultSets, graph.factRecords);

            // `compose` hands back each child row as a projected result, so
            // the fact Q projects is `result` on it.
            expect(results.map(result =>
                (result.result.k as any[]).map(child => child.result.identifier)))
                .toEqual([["c1", "c2"], ["c3"]]);
        });
    });
});
