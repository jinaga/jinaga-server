import { purgeDescendantsSql } from "../../src/postgres/purge-sql";

describe("Purge Descendants SQL", () => {
    it("should handle single trigger", () => {
        const sql = purgeDescendantsSql(1, 'public');

        const expected =
            `WITH purge_root AS (\n` +
            `    SELECT pr.fact_id\n` +
            `    FROM public.fact pr\n` +
            `    WHERE pr.fact_type_id = $1\n` +
            `        AND pr.hash = $2\n` +
            `), triggers AS (\n` +
            `    SELECT t.fact_id\n` +
            `    FROM public.fact t\n` +
            `    WHERE (t.fact_type_id = $3 AND t.hash = $4)\n` +
            `), triggers_and_ancestors AS (\n` +
            `    SELECT t.fact_id\n` +
            `    FROM triggers t\n` +
            `    UNION\n` +
            `    SELECT a.ancestor_fact_id\n` +
            `    FROM public.ancestor a\n` +
            `    JOIN triggers t\n` +
            `        ON a.fact_id = t.fact_id\n` +
            `), targets AS (\n` +
            `    SELECT a.fact_id\n` +
            `    FROM public.ancestor a\n` +
            `    JOIN purge_root pr\n` +
            `        ON a.ancestor_fact_id = pr.fact_id\n` +
            `    WHERE a.fact_id NOT IN (SELECT * FROM triggers_and_ancestors)\n` +
            `), facts AS (\n` +
            `    DELETE\n` +
            `    FROM public.fact f\n` +
            `    USING targets t WHERE t.fact_id = f.fact_id\n` +
            `    RETURNING f.fact_id\n` +
            `)\n` +
            `SELECT fact_id FROM facts\n`;

        expect(sql).toBe(expected);
    });
});