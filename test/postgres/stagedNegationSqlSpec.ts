import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, getFactTypeId } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";

// Issue #224, Build step 3. `readAsIfSaved` writes the staged facts into a
// transaction it rolls back, then runs the same query tree `read` would, with
// one difference: beneath a negative existential condition, at any depth,
// every fact a successor walk joins excludes the staged ids. A predecessor
// walk does not, because it reads a staged fact's own predecessors.
//
// These pin where the exclusion goes. Whether the rows are then right is
// pinned against PostgreSQL in integration-test/, by the conformance suite
// jinaga exports and by read-as-if-saved.test.js.

const company = dehydrateReference({ type: "Company" });
const stagedIds = [101, 102];

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function queriesFor(descriptiveString: string, staged: number[]) {
    const specification = parseSpecification(descriptiveString);
    const factTypes = getAllFactTypes(specification).reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());
    const roleMap = getAllRoles(specification).reduce(
        (r, role, i) => addRole(r, getFactTypeId(factTypes, role.successorType)!, role.name, i + 1),
        emptyRoleMap());
    const composer = resultSqlFromSpecification([company], specification, factTypes, roleMap, "public", staged);
    if (!composer) {
        throw new Error("The specification is not satisfiable.");
    }
    return composer.getSqlQueries();
}

// The fact indexes whose join excludes the staged ids, in order of appearance.
function excludedFacts(sql: string, parameter: number): number[] {
    const pattern = new RegExp(`AND f(\\d+)\\.fact_id <> ALL\\(\\$${parameter}::integer\\[\\]\\)`, "g");
    return [...sql.matchAll(pattern)].map(m => Number(m[1]));
}

const openOffices = `
    (company: Company) {
        office: Office [
            office->company: Company = company
            !E {
                closed: Office.Closed [
                    closed->office: Office = office
                ]
            }
        ]
    } => office
`;

describe("readAsIfSaved SQL", () => {
    it("generates the read SQL when nothing is staged", () => {
        const read = queriesFor(openOffices, []);
        const staged = queriesFor(openOffices, stagedIds);
        expect(read.sqlQuery.sql).not.toContain("<> ALL");
        expect(staged.sqlQuery.sql).not.toEqual(read.sqlQuery.sql);
        expect(staged.sqlQuery.sql.replace(/ AND f\d+\.fact_id <> ALL\(\$\d+::integer\[\]\)/g, ""))
            .toEqual(read.sqlQuery.sql);
    });

    it("leaves a specification with no negative condition unchanged, and binds nothing extra", () => {
        const specification = `
            (company: Company) {
                office: Office [
                    office->company: Company = company
                    E {
                        closed: Office.Closed [
                            closed->office: Office = office
                        ]
                    }
                ]
            } => office
        `;
        const read = queriesFor(specification, []);
        const staged = queriesFor(specification, stagedIds);
        expect(staged.sqlQuery.sql).toEqual(read.sqlQuery.sql);
        expect(staged.sqlQuery.parameters).toEqual(read.sqlQuery.parameters);
    });

    it("excludes staged facts from the successor a negative condition joins, and only there", () => {
        const read = queriesFor(openOffices, []);
        const { sqlQuery } = queriesFor(openOffices, stagedIds);
        const parameter = read.sqlQuery.parameters.length + 1;

        expect(sqlQuery.parameters).toEqual([...read.sqlQuery.parameters, stagedIds]);
        const notExists = sqlQuery.sql.indexOf("NOT EXISTS");
        // The office match is outside the negation, so it sees staged offices.
        expect(excludedFacts(sqlQuery.sql.slice(0, notExists), parameter)).toEqual([]);
        // The closure is a successor of the office, so it does not.
        expect(excludedFacts(sqlQuery.sql.slice(notExists), parameter)).toHaveLength(1);
    });

    it("excludes staged facts from a positive condition nested inside a negative one", () => {
        const specification = `
            (company: Company) {
                office: Office [
                    office->company: Company = company
                    !E {
                        closed: Office.Closed [
                            closed->office: Office = office
                            E {
                                reopened: Office.Reopened [
                                    reopened->officeClosed: Office.Closed = closed
                                ]
                            }
                        ]
                    }
                ]
            } => office
        `;
        const read = queriesFor(specification, []);
        const { sqlQuery } = queriesFor(specification, stagedIds);
        const parameter = read.sqlQuery.parameters.length + 1;
        const inner = sqlQuery.sql.lastIndexOf("EXISTS");

        expect(excludedFacts(sqlQuery.sql, parameter)).toHaveLength(2);
        expect(excludedFacts(sqlQuery.sql.slice(inner), parameter)).toHaveLength(1);
    });

    it("lets a positive condition outside the negation see staged facts, and excludes them beneath it", () => {
        const specification = `
            (company: Company) {
                office: Office [
                    office->company: Company = company
                    E {
                        closed: Office.Closed [
                            closed->office: Office = office
                            !E {
                                reopened: Office.Reopened [
                                    reopened->officeClosed: Office.Closed = closed
                                ]
                            }
                        ]
                    }
                ]
            } => office
        `;
        const read = queriesFor(specification, []);
        const { sqlQuery } = queriesFor(specification, stagedIds);
        const parameter = read.sqlQuery.parameters.length + 1;
        const notExists = sqlQuery.sql.indexOf("NOT EXISTS");

        expect(excludedFacts(sqlQuery.sql.slice(0, notExists), parameter)).toEqual([]);
        expect(excludedFacts(sqlQuery.sql.slice(notExists), parameter)).toHaveLength(1);
    });

    it("does not exclude staged facts from a predecessor walk beneath a negative condition", () => {
        const specification = `
            (company: Company) {
                office: Office [
                    office->company: Company = company
                    !E {
                        other: Office [
                            other->company: Company = office->company: Company
                        ]
                    }
                ]
            } => office
        `;
        const read = queriesFor(specification, []);
        const { sqlQuery } = queriesFor(specification, stagedIds);
        const parameter = read.sqlQuery.parameters.length + 1;
        const notExists = sqlQuery.sql.slice(sqlQuery.sql.indexOf("NOT EXISTS"));

        // Two facts are joined beneath the negation: the office's company, by
        // a predecessor walk, and the other office, by a successor walk.
        const joined = [...notExists.matchAll(/JOIN public\.fact f(\d+)/g)].map(m => Number(m[1]));
        expect(joined).toHaveLength(2);
        expect(excludedFacts(notExists, parameter)).toEqual([joined[1]]);
    });
});
