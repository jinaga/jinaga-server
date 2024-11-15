import { ensureGetFactTypeId, FactTypeMap, getRoleId } from "../../src/postgres/maps";
import { purgeSqlFromSpecification } from "../../src/postgres/purge-sql";
import { model, Site, SiteDeleted, SitePurged } from "../models/blog";

describe("Purge SQL", () => {
    it("should handle direct successor", () => {
        const specification = model.given(Site).match((site, facts) =>
            facts.ofType(SiteDeleted)
                .join(deleted => deleted.site, site)
        ).specification;
        const factTypes = buildFactTypeMap(
            Site.Type,
            SiteDeleted.Type
        );
        const roleMap = buildRoleMap(factTypes,
            [Site.Type, ['creator']],
            [SiteDeleted.Type, ['site']]
        );
        const schema = 'public';
        const { sql, parameters } = purgeSqlFromSpecification(specification, factTypes, roleMap, schema);

        const expected =
`WITH candidates AS (
    SELECT
        f1.fact_id as purge_root,
        f2.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $3
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    WHERE f1.fact_type_id = $1
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN candidates c ON c.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM candidates c2
        WHERE a.fact_id = c.trigger1
    )
), facts AS (
    DELETE
    FROM public.fact f
    USING targets t WHERE t.fact_id = f.fact_id
    RETURNING f.fact_id
)
SELECT fact_id FROM facts
`;

        expect(sql).toBe(expected);
        expect(parameters).toEqual([
            ensureGetFactTypeId(factTypes, Site.Type),
            'xxxxx',
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site')
        ]);
    });

    it("should handle two levels of successors", () => {
        const specification = model.given(Site).match((site, facts) =>
            facts.ofType(SitePurged)
                .join(purged => purged.deleted.site, site)
        ).specification;
        const factTypes = buildFactTypeMap(
            Site.Type,
            SiteDeleted.Type,
            SitePurged.Type
        );
        const roleMap = buildRoleMap(factTypes,
            [Site.Type, ['creator']],
            [SiteDeleted.Type, ['site']],
            [SitePurged.Type, ['deleted']]
        );
        const schema = 'public';
        const { sql, parameters } = purgeSqlFromSpecification(specification, factTypes, roleMap, schema);

        const expected =
`WITH candidates AS (
    SELECT
        f1.fact_id as purge_root,
        f3.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $3
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    JOIN public.edge e2
        ON e2.predecessor_fact_id = f2.fact_id
        AND e2.role_id = $4
    JOIN public.fact f3
        ON f3.fact_id = e2.successor_fact_id
    WHERE f1.fact_type_id = $1
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN candidates c ON c.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM candidates c2
        WHERE a.fact_id = c.trigger1
    )
), facts AS (
    DELETE
    FROM public.fact f
    USING targets t WHERE t.fact_id = f.fact_id
    RETURNING f.fact_id
)
SELECT fact_id FROM facts
`;

        expect(sql).toBe(expected);
        expect(parameters).toEqual([
            ensureGetFactTypeId(factTypes, Site.Type),
            'xxxxx',
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site'),
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SitePurged.Type), 'deleted')
        ]);
    });
});

function buildFactTypeMap(...types: string[]): FactTypeMap {
    const factTypeMap: FactTypeMap = new Map();
    types.forEach((type, index) => {
        factTypeMap.set(type, index + 1);
    });
    return factTypeMap;
}

function buildRoleMap(factTypes: FactTypeMap, ...args: [string, string[]][]): Map<number, Map<string, number>> {
    const roleMap = new Map<number, Map<string, number>>();
    args.forEach(([type, roles]) => {
        const typeId = factTypes.get(type);
        if (typeId === undefined) {
            throw new Error(`Unknown fact type: ${type}`);
        }
        const roleIdMap = new Map<string, number>();
        roles.forEach((role, roleIndex) => {
            roleIdMap.set(role, typeId * 10 + roleIndex + 1);
        });
        roleMap.set(typeId, roleIdMap);
    });
    return roleMap;
}