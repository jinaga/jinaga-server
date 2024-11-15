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

        expect(sql).toBe(
`
`);
    });
});