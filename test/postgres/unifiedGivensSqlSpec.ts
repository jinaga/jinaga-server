import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, RoleMap } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";

// Issue #232. A match whose identities bind two givens to one unknown unifies
// both givens onto a single fact index: the fact carries an input for each, and
// the read returns it only when both type-and-hash filters hold, which is how
// it compares the two givens. The match has no roles, so the query has no edges
// and `joinGivens` writes the FROM clause. It emitted one CROSS JOIN per input
// after the first without checking whether that input's fact index was already
// in the FROM clause, so the alias appeared twice and Postgres rejected the
// statement with `table name "f1" specified more than once`.

const company = dehydrateReference({ type: "Company", identifier: "TestCompany" });
const office = dehydrateReference({ type: "Office", company: company, identifier: "TestOffice" });
const otherOffice = dehydrateReference({ type: "Office", company: company, identifier: "OtherOffice" });

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

// Each given takes a distinct fact, so the two hash parameters differ. The
// unification is in the specification, not in what the caller passes.
function readQueryFor(descriptiveString: string) {
    const maps = mapsFor(descriptiveString);
    const specification = parseSpecification(descriptiveString);
    const start = specification.given.map(given => {
        if (given.label.name === "other") {
            return otherOffice;
        }
        if (given.label.type === "Office") {
            return office;
        }
        if (given.label.type === "Company") {
            return company;
        }
        throw new Error(`Unknown given ${given.label.name}: ${given.label.type}`);
    });
    const composer = resultSqlFromSpecification(start, specification, maps.factTypes, maps.roleMap, "public");
    return { query: composer!.getSqlQueries().sqlQuery, ...maps };
}

function typeId(factTypes: FactTypeMap, type: string): number {
    const id = getFactTypeId(factTypes, type);
    if (!id) {
        throw new Error(`Unknown fact type ${type}`);
    }
    return id;
}

function columns(factIndex: number): string {
    return `f${factIndex}.hash as hash${factIndex}, f${factIndex}.fact_id as id${factIndex}, ` +
        `f${factIndex}.data as data${factIndex}, f${factIndex}.date_learned as timestamp${factIndex}`;
}

// The aliases the FROM clause declares, read back out of the generated SQL
// rather than asserted against a copy of it. A repeated alias is the defect,
// whatever the rest of the statement looks like.
function fromClauseAliases(sql: string): string[] {
    const fromClause = /\sFROM\s(.*?)(?:\sWHERE\s|$)/.exec(sql);
    if (!fromClause) {
        throw new Error(`No FROM clause in ${sql}`);
    }
    return Array.from(fromClause[1].matchAll(/public\.fact\s+(f\d+)/g)).map(match => match[1]);
}

const twoGivensOnOneUnknown = `
    (office: Office, other: Office) {
        o: Office [
            o = office
            o = other
        ]
    } => o
`;

describe("Postgres read of two givens unified onto one fact", () => {
    it("references the shared fact once in the FROM clause", () => {
        const { query, factTypes } = readQueryFor(twoGivensOnOneUnknown);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(1)}, ${columns(1)} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f1.fact_type_id = $3 AND f1.hash = $4 ` +
            `ORDER BY f1.fact_id ASC`
        );
        // Both givens' filters survive on the one fact. Those filters are what
        // compare the givens: the fact matches both hashes only when the two
        // givens are the same fact.
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            typeId(factTypes, "Office"),
            otherOffice.hash
        ]);
        expect(query.labels).toEqual([
            { name: "office", type: "Office", index: 1 },
            { name: "other", type: "Office", index: 1 },
            { name: "o", type: "Office", index: 1 }
        ]);
    });

    it("declares no alias twice, however many givens unify", () => {
        const sqls = [
            readQueryFor(twoGivensOnOneUnknown).query.sql,
            readQueryFor(`
                (office: Office, other: Office, third: Office) {
                    o: Office [
                        o = office
                        o = other
                        o = third
                    ]
                } => o
            `).query.sql
            // A third case stood here: a unified pair beside a given on a fact
            // index of its own, bound by its own unknown, so one statement
            // exercised both the index that is skipped and the index that is
            // still joined. That shape is outside the specification language
            // as of jinaga 6.17.0, taken in issue #250: `o` uses office and
            // other, `c` uses company, no condition joins the two, and the
            // parser now refuses the product. It cannot be made connected
            // while keeping what it was for, because a second given on a fact
            // index of its own is unreached by definition, and joining it is
            // what reaches it. The guarantee that no such specification
            // arrives is held at the boundary instead, by
            // test/http/disconnectedSpecificationSpec.ts. The two cases above
            // still cover the alias this test was written for, and "still
            // cross joins givens that do not unify" below still covers the
            // cross-join path, for givens no match uses.
        ];

        sqls.forEach(sql => {
            const aliases = fromClauseAliases(sql);
            expect(aliases).toEqual(Array.from(new Set(aliases)));
        });
    });

    it("still cross joins givens that do not unify", () => {
        const { query } = readQueryFor(`
            (office: Office, company: Company) {
            } => office
        `);

        expect(query.sql).toEqual(
            `SELECT ${columns(1)}, ${columns(2)} ` +
            `FROM public.fact f1 ` +
            `CROSS JOIN public.fact f2 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f2.fact_type_id = $3 AND f2.hash = $4`
        );
    });
});
