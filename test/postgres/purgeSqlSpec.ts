import { Specification } from "jinaga";
import { ensureGetFactTypeId, FactTypeMap, getRoleId } from "../../src/postgres/maps";
import { purgeSqlFromSpecification, purgeSqlFromSpecifications } from "../../src/postgres/purge-sql";
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
        const { sql, parameters } = whenGeneratePurgeSql(specification, factTypes, roleMap, schema);

        const expected =
`WITH candidates1 AS (
    SELECT
        f1.fact_id as purge_root,
        f2.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $2
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    WHERE f1.fact_type_id = $1
), roots AS (
    SELECT purge_root FROM candidates1
), triggers AS (
    SELECT trigger1 AS fact_id FROM candidates1
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN roots r ON r.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM triggers t
        WHERE a.fact_id = t.fact_id
    )
    AND NOT EXISTS (
        SELECT 1
        FROM triggers t
        JOIN public.ancestor a2
            ON a2.fact_id = t.fact_id
        WHERE a.fact_id = a2.ancestor_fact_id
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
        const { sql, parameters } = whenGeneratePurgeSql(specification, factTypes, roleMap, schema);

        const expected =
`WITH candidates1 AS (
    SELECT
        f1.fact_id as purge_root,
        f3.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $2
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    JOIN public.edge e2
        ON e2.predecessor_fact_id = f2.fact_id
        AND e2.role_id = $3
    JOIN public.fact f3
        ON f3.fact_id = e2.successor_fact_id
    WHERE f1.fact_type_id = $1
), roots AS (
    SELECT purge_root FROM candidates1
), triggers AS (
    SELECT trigger1 AS fact_id FROM candidates1
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN roots r ON r.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM triggers t
        WHERE a.fact_id = t.fact_id
    )
    AND NOT EXISTS (
        SELECT 1
        FROM triggers t
        JOIN public.ancestor a2
            ON a2.fact_id = t.fact_id
        WHERE a.fact_id = a2.ancestor_fact_id
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
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site'),
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SitePurged.Type), 'deleted')
        ]);
    });

    it("should handle two labeled successors", () => {
        const specification = model.given(Site).match((site, facts) =>
            facts.ofType(SiteDeleted)
                .join(deleted => deleted.site, site)
            .selectMany(deleted =>
                facts.ofType(SitePurged)
                    .join(purged => purged.deleted, deleted)
            )).specification;
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
        const { sql, parameters } = whenGeneratePurgeSql(specification, factTypes, roleMap, schema);

        const expected =
`WITH candidates1 AS (
    SELECT
        f1.fact_id as purge_root,
        f2.fact_id as trigger1,
        f3.fact_id as trigger2
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $2
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    JOIN public.edge e2
        ON e2.predecessor_fact_id = f2.fact_id
        AND e2.role_id = $3
    JOIN public.fact f3
        ON f3.fact_id = e2.successor_fact_id
    WHERE f1.fact_type_id = $1
), roots AS (
    SELECT purge_root FROM candidates1
), triggers AS (
    SELECT trigger1 AS fact_id FROM candidates1
    UNION
    SELECT trigger2 AS fact_id FROM candidates1
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN roots r ON r.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM triggers t
        WHERE a.fact_id = t.fact_id
    )
    AND NOT EXISTS (
        SELECT 1
        FROM triggers t
        JOIN public.ancestor a2
            ON a2.fact_id = t.fact_id
        WHERE a.fact_id = a2.ancestor_fact_id
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
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site'),
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SitePurged.Type), 'deleted')
        ]);
    });
    it("should spare the triggers of every condition on one given type", () => {
        const deletedSpecification = model.given(Site).match((site, facts) =>
            facts.ofType(SiteDeleted)
                .join(deleted => deleted.site, site)
        ).specification;
        const purgedSpecification = model.given(Site).match((site, facts) =>
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
        const purgeCommand = purgeSqlFromSpecifications([deletedSpecification, purgedSpecification], factTypes, roleMap, 'public');
        if (purgeCommand === null) {
            throw new Error("The specifications were not satisfiable.");
        }
        const { sql, parameters } = purgeCommand;

        const expected =
`WITH candidates1 AS (
    SELECT
        f1.fact_id as purge_root,
        f2.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $2
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    WHERE f1.fact_type_id = $1
), candidates2 AS (
    SELECT
        f1.fact_id as purge_root,
        f3.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $4
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    JOIN public.edge e2
        ON e2.predecessor_fact_id = f2.fact_id
        AND e2.role_id = $5
    JOIN public.fact f3
        ON f3.fact_id = e2.successor_fact_id
    WHERE f1.fact_type_id = $3
), roots AS (
    SELECT purge_root FROM candidates1
    UNION
    SELECT purge_root FROM candidates2
), triggers AS (
    SELECT trigger1 AS fact_id FROM candidates1
    UNION
    SELECT trigger1 AS fact_id FROM candidates2
), targets AS (
    SELECT a.fact_id
    FROM public.ancestor a
    JOIN roots r ON r.purge_root = a.ancestor_fact_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM triggers t
        WHERE a.fact_id = t.fact_id
    )
    AND NOT EXISTS (
        SELECT 1
        FROM triggers t
        JOIN public.ancestor a2
            ON a2.fact_id = t.fact_id
        WHERE a.fact_id = a2.ancestor_fact_id
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
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site'),
            ensureGetFactTypeId(factTypes, Site.Type),
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SiteDeleted.Type), 'site'),
            getRoleId(roleMap, ensureGetFactTypeId(factTypes, SitePurged.Type), 'deleted')
        ]);
    });
});

function whenGeneratePurgeSql(specification: Specification, factTypes: FactTypeMap, roleMap: Map<number, Map<string, number>>, schema: string) {
    const purgeCommand = purgeSqlFromSpecification(specification, factTypes, roleMap, schema);
    if (purgeCommand === null) {
        throw new Error("The specification was not satisfiable.");
    }
    return purgeCommand;
}

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