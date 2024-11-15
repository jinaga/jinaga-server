ROLLBACK TRANSACTION;

BEGIN TRANSACTION;

WITH candidates AS (
    SELECT
        f1.fact_id as purge_root,
        f2.fact_id as trigger1
    FROM public.fact f1
    JOIN public.edge e1
        ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = 26
    JOIN public.fact f2
        ON f2.fact_id = e1.successor_fact_id
    WHERE f1.fact_type_id = 2
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
SELECT fact_id FROM facts;

ROLLBACK TRANSACTION;