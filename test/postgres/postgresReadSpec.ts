import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";
import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, getFactTypeId, getRoleId } from "../../src/postgres/maps";
import { resultSqlFromSpecification } from "../../src/postgres/specification-result-sql";

const company = dehydrateReference({ type: "Company" });
const companyHash = company.hash;
const user = dehydrateReference({ type: "Jinaga.User", publicKey: "PUBLIC KEY"});
const userHash = user.hash;

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function sqlFor(descriptiveString: string, bookmarks: string[] = []) {
    const specification = parseSpecification(descriptiveString);
    const factTypeNames = getAllFactTypes(specification);

    // Build a fact type map containing all fact types in the specification.
    // Filter out fact types named "Unknown".
    const factTypes = factTypeNames.filter(t => t !== 'Unknown').reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());

    // Build a role map containing all roles in the specification.
    // Filter out the roles named "unknown", and those of unknown fact types.
    let roleMap = getAllRoles(specification).filter(r => r.name !== 'unknown').reduce(
        (r, role, i) => {
            const factTypeId = getFactTypeId(factTypes, role.successorType);
            if (!factTypeId) {
                return r;
            }
            return addRole(r, factTypeId, role.name, i + 1);
        },
        emptyRoleMap());
    const start = specification.given.map(input => {
        if (input.type === "Company") {
            return company;
        }
        if (input.type === "Jinaga.User") {
            return user;
        }
        throw new Error(`Unknown input type ${input.type}`);
    });
    const composer = resultSqlFromSpecification(start, specification, factTypes, roleMap, "public");
    if (!composer) {
        throw new Error("The specification is not satisfiable.");
    }
    return { composer, factTypes, roleMap };
}

function roleParameter(roleMap: Map<number, Map<string, number>>, factTypes: Map<string, number>, factTypeName: string, roleName: string): number {
    const factTypeId = getFactTypeId(factTypes, factTypeName);
    if (!factTypeId) {
        throw new Error(`Unknown fact type ${factTypeName}`);
    }
    const roleId = getRoleId(roleMap, factTypeId, roleName);
    if (!roleId) {
        throw new Error(`Unknown role ${roleName} in fact type ${factTypeName}`);
    }
    return roleId;
}

describe("Postgres read", () => {
    it("should join successors", () => {
        const { composer } = sqlFor(`
            (company: Company) {
                department: Department [
                    department->company: Company = company
                ]
            }
        `);

        const sql = composer.getSqlQueries().sqlQuery.sql;
        expect(sql).toEqual(
            `SELECT f2.hash as hash2, f2.fact_id as id2, f2.data as data2 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ` +
                `ON e1.predecessor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ` +
                `ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `ORDER BY f2.fact_id ASC`
        );
    });

    it("should apply negative existential conditions", () => {
        const { composer, factTypes, roleMap } = sqlFor(`
            (company: Company) {
                project: Project [
                    project->department: Department->company: Company = company
                    !E {
                        deleted: Project.Deleted [
                            deleted->project: Project = project
                        ]
                    }
                ]
            }
        `);

        const tree = composer.getSqlQueries();
        const sql = tree.sqlQuery.sql;
        expect(sql).toEqual(
            `SELECT f3.hash as hash3, f3.fact_id as id3, f3.data as data3 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ` +
                `ON e1.predecessor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ` +
                `ON f2.fact_id = e1.successor_fact_id ` +
            `JOIN public.edge e2 ` +
                `ON e2.predecessor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4 ` +
            `JOIN public.fact f3 ` +
                `ON f3.fact_id = e2.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 ` +
                `FROM public.edge e3 ` +
                `JOIN public.fact f4 ` +
                    `ON f4.fact_id = e3.successor_fact_id ` +
                `WHERE e3.predecessor_fact_id = f3.fact_id ` +
                    `AND e3.role_id = $5` +
            `) ` +
            `ORDER BY f3.fact_id ASC`
        );
        expect(tree.sqlQuery.parameters).toEqual([
            getFactTypeId(factTypes, 'Company'),
            companyHash,
            roleParameter(roleMap, factTypes, 'Department', 'company'),
            roleParameter(roleMap, factTypes, 'Project', 'department'),
            roleParameter(roleMap, factTypes, 'Project.Deleted', 'project')
        ]);
    });

    it("should apply positive existential conditions", () => {
        const { composer, factTypes, roleMap } = sqlFor(`
            (company: Company) {
                project: Project [
                    project->department: Department->company: Company = company
                    E {
                        deleted: Project.Deleted [
                            deleted->project: Project = project
                        ]
                    }
                ]
            }
        `);

        const tree = composer.getSqlQueries();
        const sql = tree.sqlQuery.sql;
        expect(sql).toEqual(
            `SELECT f3.hash as hash3, f3.fact_id as id3, f3.data as data3 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ` +
                `ON e1.predecessor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ` +
                `ON f2.fact_id = e1.successor_fact_id ` +
            `JOIN public.edge e2 ` +
                `ON e2.predecessor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4 ` +
            `JOIN public.fact f3 ` +
                `ON f3.fact_id = e2.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND EXISTS (` +
                `SELECT 1 ` +
                `FROM public.edge e3 ` +
                `JOIN public.fact f4 ` +
                    `ON f4.fact_id = e3.successor_fact_id ` +
                `WHERE e3.predecessor_fact_id = f3.fact_id ` +
                    `AND e3.role_id = $5` +
            `) ` +
            `ORDER BY f3.fact_id ASC`
        );
        expect(tree.sqlQuery.parameters).toEqual([
            getFactTypeId(factTypes, 'Company'),
            companyHash,
            roleParameter(roleMap, factTypes, 'Department', 'company'),
            roleParameter(roleMap, factTypes, 'Project', 'department'),
            roleParameter(roleMap, factTypes, 'Project.Deleted', 'project')
        ]);
    });

    it("should read nested existential conditions", () => {
        const { composer, factTypes, roleMap } = sqlFor(`
            (company: Company) {
                project: Project [
                    project->company: Company = company
                    !E {
                        deleted: Project.Deleted [
                            deleted->project: Project = project
                            !E {
                                restored: Project.Restored [
                                    restored->deleted: Project.Deleted = deleted
                                ]
                            }
                        ]
                    }
                ]
            } => project
        `);

        const tree = composer.getSqlQueries();
        const sql = tree.sqlQuery.sql;
        expect(sql).toEqual(
            `SELECT f2.hash as hash2, f2.fact_id as id2, f2.data as data2 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ` +
                `ON e1.predecessor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ` +
                `ON f2.fact_id = e1.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
            `AND NOT EXISTS (` +
                `SELECT 1 ` +
                `FROM public.edge e2 ` +
                `JOIN public.fact f3 ` +
                    `ON f3.fact_id = e2.successor_fact_id ` +
                `WHERE e2.predecessor_fact_id = f2.fact_id ` +
                    `AND e2.role_id = $4 ` +
                `AND NOT EXISTS (` +
                    `SELECT 1 ` +
                    `FROM public.edge e3 ` +
                    `JOIN public.fact f4 ` +
                        `ON f4.fact_id = e3.successor_fact_id ` +
                    `WHERE e3.predecessor_fact_id = f3.fact_id ` +
                        `AND e3.role_id = $5` +
                `)` +
            `) ` +
            `ORDER BY f2.fact_id ASC`
        );
        expect(tree.sqlQuery.parameters).toEqual
    });

    it("should read complex specifications", () => {
        const { composer, factTypes, roleMap } = sqlFor(`
            (company: Company, user: Jinaga.User) {
                project: Project [
                    project->department: Department->company: Company = company
                    !E {
                        deleted: Project.Deleted [
                            deleted->project: Project = project
                            !E {
                                restored: Project.Restored [
                                    restored->deleted: Project.Deleted = deleted
                                ]
                            }
                        ]
                    }
                    E {
                        assignment: Project.Assignment [
                            assignment->project: Project = project
                            assignment->user: Jinaga.User = user
                            !E {
                                revoked: Project.Assignment.Revoked [
                                    revoked->assignment: Project.Assignment = assignment
                                ]
                            }
                        ]
                    }
                ]
                deliverable: Deliverable [
                    deliverable->project: Project = project
                ]
            } => {
                assignedTasks = {
                    task: Task [
                        task->deliverable: Deliverable = deliverable
                        E {
                            assignment: Task.Assignment [
                                assignment->task: Task = task
                                assignment->user: Jinaga.User = user
                            ]
                        }
                    ]
                } => {
                    number = task.number
                }
            }
        `);

        const queries = composer.getSqlQueries();
        expect(queries.sqlQuery.sql).toEqual(
            `SELECT ` +
                `f3.hash as hash3, f3.fact_id as id3, f3.data as data3, ` +
                `f9.hash as hash9, f9.fact_id as id9, f9.data as data9 ` +
            `FROM public.fact f1 ` +
            `JOIN public.edge e1 ` +
                `ON e1.predecessor_fact_id = f1.fact_id ` +
                `AND e1.role_id = $3 ` +
            `JOIN public.fact f2 ` +
                `ON f2.fact_id = e1.successor_fact_id ` +
            `JOIN public.edge e2 ` +
                `ON e2.predecessor_fact_id = f2.fact_id ` +
                `AND e2.role_id = $4 ` +
            `JOIN public.fact f3 ` +
                `ON f3.fact_id = e2.successor_fact_id ` +
            `JOIN public.edge e8 ` +
                `ON e8.predecessor_fact_id = f3.fact_id ` +
                `AND e8.role_id = $12 ` +
            `JOIN public.fact f9 ` +
                `ON f9.fact_id = e8.successor_fact_id ` +
            `WHERE f1.fact_type_id = $1 AND f1.hash = $2 ` +
                `AND NOT EXISTS (` +
                    `SELECT 1 ` +
                    `FROM public.edge e3 ` +
                    `JOIN public.fact f4 ` +
                        `ON f4.fact_id = e3.successor_fact_id ` +
                    `WHERE e3.predecessor_fact_id = f3.fact_id ` +
                        `AND e3.role_id = $5 ` +
                        `AND NOT EXISTS (` +
                            `SELECT 1 ` +
                            `FROM public.edge e4 ` +
                            `JOIN public.fact f5 ` +
                                `ON f5.fact_id = e4.successor_fact_id ` +
                            `WHERE e4.predecessor_fact_id = f4.fact_id AND e4.role_id = $6` +
                        `)` +
                `) AND EXISTS (` +
                    `SELECT 1 ` +
                    `FROM public.edge e5 ` +
                    `JOIN public.fact f6 ` +
                        `ON f6.fact_id = e5.successor_fact_id ` +
                    `JOIN public.edge e6 ` +
                        `ON e6.successor_fact_id = f6.fact_id ` +
                        `AND e6.role_id = $10 ` +
                    `JOIN public.fact f7 ` +
                        `ON f7.fact_id = e6.predecessor_fact_id ` +
                    `WHERE e5.predecessor_fact_id = f3.fact_id AND e5.role_id = $7 ` +
                        `AND f7.fact_type_id = $8 AND f7.hash = $9 ` +
                        `AND NOT EXISTS (` +
                            `SELECT 1 ` +
                            `FROM public.edge e7 ` +
                            `JOIN public.fact f8 ` +
                                `ON f8.fact_id = e7.successor_fact_id ` +
                            `WHERE e7.predecessor_fact_id = f6.fact_id AND e7.role_id = $11` +
                        `)` +
                `) ` +
            `ORDER BY f3.fact_id ASC, f9.fact_id ASC`);
    });
});