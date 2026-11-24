--
-- Restore the fact id order of a database that holds an inverted edge.
--
-- Every edge is meant to run from a lower fact id to a higher one, because a
-- fact is saved after the predecessors it names. A feed page's bookmark bound
-- rests on that, and setup.sql records it as the CHECK constraint
-- ck_edge_successor_after_predecessor, which the server reads before it drops
-- a redundant bound. A database written before the facts of one save were
-- ordered may hold edges that violate it, so setup.sql adds the constraint
-- NOT VALID and leaves it unvalidated. This script restores the order and
-- validates it.
--
-- Run it as maintenance. It takes ACCESS EXCLUSIVE on the edge table for its
-- constraint DDL, so feed reads wait for its duration, and an inverted fact
-- high in the graph means rewriting every fact beneath it.
--
-- Ids move UP ONLY, to fresh values above the current maximum. That is what
-- makes it safe for a reader that is already paging a feed:
--
--   * A moved fact lands above every bookmark already handed out, so no reader
--     misses it.
--   * A reader whose bookmark had passed the fact's old id receives the fact
--     again at its new id, which is harmless, because clients deduplicate
--     facts by hash.
--
-- Moving an id down could put a fact behind a bookmark a reader has already
-- passed, so this script never does.
--
-- Running it a second time moves nothing and succeeds.
--
--     psql "$CONNECTION_STRING" -f repair-edge-order.sql
--

BEGIN;

-- The same lock every save takes, so this runs between saves rather than
-- across one. Transaction-scoped: the commit or rollback below releases it.
SELECT pg_advisory_xact_lock(1263186513::bigint);

LOCK TABLE public.fact, public.edge, public.ancestor, public.signature
    IN SHARE ROW EXCLUSIVE MODE;

--
-- The facts to move: the successor of every inverted edge, and everything
-- descended from one. Descendants come from the ancestor table, which holds
-- the transitive closure, so one pass finds them all.
--
-- Their new ids are assigned in topological order, which sorting by ancestor
-- count gives: a fact's ancestors are a strict superset of any one of its
-- ancestors' own, so it has strictly more of them. The fact id breaks ties
-- between facts at the same depth, which keeps the assignment deterministic.
--
CREATE TEMPORARY TABLE moved_fact ON COMMIT DROP AS
WITH inverted AS (
    SELECT DISTINCT successor_fact_id AS fact_id
    FROM public.edge
    WHERE successor_fact_id < predecessor_fact_id
),
affected AS (
    SELECT fact_id
    FROM inverted
    UNION
    SELECT descendant.fact_id
    FROM public.ancestor descendant
    JOIN inverted
        ON inverted.fact_id = descendant.ancestor_fact_id
),
depth AS (
    SELECT
        affected.fact_id,
        (SELECT count(*)
         FROM public.ancestor
         WHERE ancestor.fact_id = affected.fact_id) AS ancestor_count
    FROM affected
)
SELECT
    depth.fact_id AS old_fact_id,
    (SELECT max(fact_id) FROM public.fact)
        + row_number() OVER (ORDER BY depth.ancestor_count, depth.fact_id)
        AS new_fact_id
FROM depth;

CREATE UNIQUE INDEX ux_moved_fact ON moved_fact (old_fact_id);

--
-- The CHECK would reject the rewrite while it is half applied, so it comes off
-- first and goes back on at the end. The foreign keys on fact.fact_id are
-- deferred rather than dropped: the edge, ancestor and signature rows point at
-- the old ids until their own updates run, and deferring the checks to the end
-- of the transaction lets the four updates run in any order.
--
ALTER TABLE public.edge
    DROP CONSTRAINT IF EXISTS ck_edge_successor_after_predecessor;

ALTER TABLE public.edge
    ALTER CONSTRAINT fk_successor_fact_id DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.edge
    ALTER CONSTRAINT fk_predecessor_fact_id DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.ancestor
    ALTER CONSTRAINT fk_fact_id DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.ancestor
    ALTER CONSTRAINT fk_ancestor_fact_id DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public."signature"
    ALTER CONSTRAINT fk_fact_id DEFERRABLE INITIALLY IMMEDIATE;

SET CONSTRAINTS ALL DEFERRED;

UPDATE public.fact
SET fact_id = moved_fact.new_fact_id
FROM moved_fact
WHERE moved_fact.old_fact_id = fact.fact_id;

-- One statement per table that names a fact id, because a row can name a moved
-- fact in either column, or in one column and an unmoved fact in the other.
UPDATE public.edge
SET successor_fact_id = COALESCE(
        (SELECT new_fact_id FROM moved_fact
         WHERE old_fact_id = edge.successor_fact_id),
        edge.successor_fact_id),
    predecessor_fact_id = COALESCE(
        (SELECT new_fact_id FROM moved_fact
         WHERE old_fact_id = edge.predecessor_fact_id),
        edge.predecessor_fact_id)
WHERE EXISTS (
    SELECT 1 FROM moved_fact
    WHERE old_fact_id IN (edge.successor_fact_id, edge.predecessor_fact_id));

UPDATE public.ancestor
SET fact_id = COALESCE(
        (SELECT new_fact_id FROM moved_fact
         WHERE old_fact_id = ancestor.fact_id),
        ancestor.fact_id),
    ancestor_fact_id = COALESCE(
        (SELECT new_fact_id FROM moved_fact
         WHERE old_fact_id = ancestor.ancestor_fact_id),
        ancestor.ancestor_fact_id)
WHERE EXISTS (
    SELECT 1 FROM moved_fact
    WHERE old_fact_id IN (ancestor.fact_id, ancestor.ancestor_fact_id));

UPDATE public."signature"
SET fact_id = moved_fact.new_fact_id
FROM moved_fact
WHERE moved_fact.old_fact_id = "signature".fact_id;

-- The sequence hands out the next id after the highest one now in use.
SELECT setval(
    pg_get_serial_sequence('public.fact', 'fact_id'),
    (SELECT max(fact_id) FROM public.fact));

-- Force the deferred foreign key checks here, so a failure rolls this
-- transaction back rather than surfacing at COMMIT.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE public.edge
    ALTER CONSTRAINT fk_successor_fact_id NOT DEFERRABLE;
ALTER TABLE public.edge
    ALTER CONSTRAINT fk_predecessor_fact_id NOT DEFERRABLE;
ALTER TABLE public.ancestor
    ALTER CONSTRAINT fk_fact_id NOT DEFERRABLE;
ALTER TABLE public.ancestor
    ALTER CONSTRAINT fk_ancestor_fact_id NOT DEFERRABLE;
ALTER TABLE public."signature"
    ALTER CONSTRAINT fk_fact_id NOT DEFERRABLE;

-- Added without NOT VALID, so Postgres scans the table and leaves the
-- constraint validated. The scan is the proof that the repair worked: if any
-- edge still runs backwards, this statement fails and the whole transaction
-- rolls back.
ALTER TABLE public.edge
    ADD CONSTRAINT ck_edge_successor_after_predecessor
    CHECK (successor_fact_id > predecessor_fact_id);

COMMIT;
