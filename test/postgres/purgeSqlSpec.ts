import { FactTypeMap } from "../../src/postgres/maps";
import { purgeSqlFromSpecification } from "../../src/postgres/purge-sql";
import { model, Site, SiteDeleted } from "../models/blog";

describe("Purge SQL", () => {
    it("should handle direct successor", () => {
        const specification = model.given(Site).match((site, facts) =>
            facts.ofType(SiteDeleted)
                .join(deleted => deleted.site, site)
        ).specification;
        const factTypes: FactTypeMap = new Map([
            [Site.Type, 1],
            [SiteDeleted.Type, 2]
        ]);
        const roleMap = new Map<number, Map<string, number>>([
            [1, new Map<string, number>([
                ['creator', 1]
            ])],
            [2, new Map<string, number>([
                ['site', 1]
            ])]
        ]);
        const schema = 'public';
        const sql = purgeSqlFromSpecification(specification, factTypes, roleMap, schema);

        const expected =
            `WITH candidates AS (
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
            ), targets AS (
                SELECT a.fact_id
                FROM public.ancestor a
                JOIN candidates c ON c.purge_root = a.ancestor_fact_id
                WHERE a.fact_id != c.trigger1
            ), facts AS (
                DELETE
                FROM public.fact f
                USING targets t WHERE t.fact_id = f.fact_id
                RETURNING f.fact_id
            )
            SELECT fact_id FROM facts`;
        // Compare with sql ignoring whitespace
        expect(sql.replace(/\s+/g, ' ')).toBe(expected.replace(/\s+/g, ' '));
    });
});