import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, getRoleId, RoleMap } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";

// Issue #226, part A. A specification with no matches selects its givens and
// applies their conditions. Before the change it produced no query at all, so
// `read` answered it with no rows.

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

function composerFor(descriptiveString: string, maps = mapsFor(descriptiveString)) {
    const specification = parseSpecification(descriptiveString);
    const start = specification.given.map(given => {
        if (given.label.type === "Office") {
            return office;
        }
        if (given.label.type === "Company") {
            return company;
        }
        throw new Error(`Unknown given type ${given.label.type}`);
    });
    return { composer: resultSqlFromSpecification(start, specification, maps.factTypes, maps.roleMap, "public"), ...maps };
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

const officeColumns =
    `f1.hash as hash1, f1.fact_id as id1, f1.data as data1, f1.date_learned as timestamp1`;

const closureCondition = (exists: boolean) => `
    (office: Office [
        ${exists ? "E" : "!E"} {
            closure: Office.Closed [
                closure->office: Office = office
            ]
        }
    ]) {
    } => office
`;

describe("Postgres read of a specification with no matches", () => {
    it("selects the given by type and hash", () => {
        const { composer, factTypes } = composerFor(`
            (office: Office) {
            } => office
        `);

        const query = composer!.getSqlQueries().sqlQuery;
        expect(query.sql).toEqual(
            `SELECT ${officeColumns} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2`
        );
        expect(query.parameters).toEqual([ typeId(factTypes, "Office"), office.hash ]);
        expect(query.labels).toEqual([ { name: "office", type: "Office", index: 1 } ]);
    });

    it("applies a negative condition on the given", () => {
        const { composer, factTypes, roleMap } = composerFor(closureCondition(false));

        const query = composer!.getSqlQueries().sqlQuery;
        expect(query.sql).toEqual(
            `SELECT ${officeColumns} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 FROM public.edge e1 ` +
                `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
                `WHERE e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3` +
            `)`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            roleId(factTypes, roleMap, "Office.Closed", "office")
        ]);
    });

    it("applies a positive condition on the given", () => {
        const { composer, factTypes, roleMap } = composerFor(closureCondition(true));

        const query = composer!.getSqlQueries().sqlQuery;
        expect(query.sql).toEqual(
            `SELECT ${officeColumns} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e1 ` +
                `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
                `WHERE e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3` +
            `)`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            roleId(factTypes, roleMap, "Office.Closed", "office")
        ]);
    });

    it("selects each of several givens", () => {
        const { composer, factTypes, roleMap } = composerFor(`
            (office: Office [
                E {
                    closure: Office.Closed [
                        closure->office: Office = office
                    ]
                }
            ], company: Company) {
            } => office
        `);

        const query = composer!.getSqlQueries().sqlQuery;
        expect(query.sql).toEqual(
            `SELECT ${officeColumns}, ` +
                `f2.hash as hash2, f2.fact_id as id2, f2.data as data2, f2.date_learned as timestamp2 ` +
            `FROM public.fact f1 ` +
            `CROSS JOIN public.fact f2 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND f2.fact_type_id = $3 AND f2.hash = $4 ` +
            `AND EXISTS (` +
                `SELECT 1 FROM public.edge e1 ` +
                `JOIN public.fact f3 ON f3.fact_id = e1.successor_fact_id ` +
                `WHERE e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $5` +
            `)`
        );
        expect(query.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            typeId(factTypes, "Company"),
            company.hash,
            roleId(factTypes, roleMap, "Office.Closed", "office")
        ]);
    });

    it("projects a child specification from the given", () => {
        const { composer, factTypes, roleMap } = composerFor(`
            (office: Office) {
            } => {
                closures = {
                    closure: Office.Closed [
                        closure->office: Office = office
                    ]
                } => closure
            }
        `);

        const tree = composer!.getSqlQueries();
        expect(tree.sqlQuery.sql).toEqual(
            `SELECT ${officeColumns} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2`
        );
        expect(tree.childQueries.map(child => child.name)).toEqual([ "closures" ]);
        expect(tree.childQueries[0].sqlQuery.sql).toEqual(
            `SELECT ${officeColumns}, ` +
                `f2.hash as hash2, f2.fact_id as id2, f2.data as data2, f2.date_learned as timestamp2 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `ORDER BY f2.fact_id ASC`
        );
        expect(tree.childQueries[0].sqlQuery.parameters).toEqual([
            typeId(factTypes, "Office"),
            office.hash,
            roleId(factTypes, roleMap, "Office.Closed", "office")
        ]);
    });

    it("cannot be satisfied when the store has never seen the given's type", () => {
        const specification = `
            (office: Office) {
            } => office
        `;
        const { composer } = composerFor(specification, { factTypes: emptyFactTypeMap(), roleMap: emptyRoleMap() });

        expect(composer).toBeNull();
    });

    it("cannot be satisfied when a positive condition names a type the store has never seen", () => {
        const specification = closureCondition(true);
        const maps = mapsFor(specification);
        const officeOnly = addFactType(emptyFactTypeMap(), "Office", typeId(maps.factTypes, "Office"));
        const { composer } = composerFor(specification, { factTypes: officeOnly, roleMap: emptyRoleMap() });

        expect(composer).toBeNull();
    });

    it("cannot be satisfied when, with a match, a positive condition on the given names a type the store has never seen", () => {
        const specification = `
            (office: Office [
                E {
                    closure: Office.Closed [
                        closure->office: Office = office
                    ]
                }
            ]) {
                president: President [
                    president->office: Office = office
                ]
            } => president
        `;
        const maps = mapsFor(specification);
        const factTypes = [ "Office", "President" ].reduce(
            (f, type) => addFactType(f, type, typeId(maps.factTypes, type)),
            emptyFactTypeMap());
        const presidentId = typeId(maps.factTypes, "President");
        const roleMap = addRole(emptyRoleMap(), presidentId, "office", roleId(maps.factTypes, maps.roleMap, "President", "office"));
        const { composer } = composerFor(specification, { factTypes, roleMap });

        expect(composer).toBeNull();
    });

    it("drops a negative condition that names a type the store has never seen", () => {
        const specification = closureCondition(false);
        const maps = mapsFor(specification);
        const officeOnly = addFactType(emptyFactTypeMap(), "Office", typeId(maps.factTypes, "Office"));
        const { composer } = composerFor(specification, { factTypes: officeOnly, roleMap: emptyRoleMap() });

        expect(composer!.getSqlQueries().sqlQuery.sql).toEqual(
            `SELECT ${officeColumns} ` +
            `FROM public.fact f1 ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2`
        );
    });
});
