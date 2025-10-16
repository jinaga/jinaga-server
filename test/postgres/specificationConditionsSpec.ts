import { dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";

import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, getFactTypeId, getRoleId } from "../../src/postgres/maps";
import { sqlFromSpecification } from "../../src/postgres/specification-sql";

const root = dehydrateReference({ type: 'Root' });
const rootHash = root.hash;

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
        if (input.label.type === 'Root') {
            return root;
        }
        throw new Error(`Unknown input type ${input.label.type}`);
    });
    const sqlQueries = sqlFromSpecification(start, "public", bookmarks, 100, specification, factTypes, roleMap);
    return { sqlQueries, factTypes, roleMap };
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

describe("Specification conditions", () => {
    describe("Processing given conditions", () => {
        it("should generate SQL for single existential condition on given", () => {
            const { sqlQueries, factTypes, roleMap } = sqlFor(`
                (root: Root [
                    E {
                        tag: MyApplication.Tag [
                            tag->root: Root = root
                        ]
                    }
                ]) {
                    project: MyApplication.Project [
                        project->root: Root = root
                    ]
                }
            `);

            expect(sqlQueries.length).toBe(1);
            const query = sqlQueries[0];
            
            // The SQL should include an EXISTS clause for the condition on the given
            expect(query.sql).toContain('EXISTS');
            expect(query.sql).toEqual(
                'SELECT f2.hash as hash2, ' +
                'sort(array[f2.fact_id], \'desc\') as bookmark ' +
                'FROM public.fact f1 ' +
                'JOIN public.edge e1 ON e1.predecessor_fact_id = f1.fact_id AND e1.role_id = $3 ' +
                'JOIN public.fact f2 ON f2.fact_id = e1.successor_fact_id ' +
                'WHERE f1.fact_type_id = $1 AND f1.hash = $2 ' +
                'AND EXISTS (' +
                    'SELECT 1 ' +
                    'FROM public.edge e2 ' +
                    'JOIN public.fact f3 ON f3.fact_id = e2.successor_fact_id ' +
                    'WHERE e2.predecessor_fact_id = f1.fact_id AND e2.role_id = $4' +
                ') ' +
                'AND sort(array[f2.fact_id], \'desc\') > $5 ' +
                'ORDER BY bookmark ASC ' +
                'LIMIT $6'
            );
            expect(query.parameters).toEqual([
                getFactTypeId(factTypes, 'Root'),
                rootHash,
                roleParameter(roleMap, factTypes, 'MyApplication.Project', 'root'),
                roleParameter(roleMap, factTypes, 'MyApplication.Tag', 'root'),
                [],
                100
            ]);
            expect(query.labels).toEqual([
                {
                    type: 'MyApplication.Project',
                    index: 2
                }
            ]);
        });
    });
});