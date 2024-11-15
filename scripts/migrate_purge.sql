GRANT DELETE ON TABLE public.edge TO appuser;
GRANT DELETE ON TABLE public.signature TO appuser;
GRANT DELETE ON TABLE public.ancestor TO appuser;
GRANT DELETE ON TABLE public.fact TO appuser;

-- Configure cascade delete from fact to edge
ALTER TABLE public.edge
    DROP CONSTRAINT fk_predecessor_fact_id;
ALTER TABLE public.edge
    ADD CONSTRAINT fk_predecessor_fact_id
    FOREIGN KEY (predecessor_fact_id)
    REFERENCES public.fact (fact_id)
    ON DELETE CASCADE;
ALTER TABLE public.edge
    DROP CONSTRAINT fk_successor_fact_id;
ALTER TABLE public.edge
    ADD CONSTRAINT fk_successor_fact_id
    FOREIGN KEY (successor_fact_id)
    REFERENCES public.fact (fact_id)
    ON DELETE CASCADE;

-- Configure cascade delete from fact to signature
ALTER TABLE public.signature
    DROP CONSTRAINT fk_fact_id;
ALTER TABLE public.signature
    ADD CONSTRAINT fk_fact_id
    FOREIGN KEY (fact_id)
    REFERENCES public.fact (fact_id)
    ON DELETE CASCADE;

-- Configure cascade delete from fact to ancestor
ALTER TABLE public.ancestor
    DROP CONSTRAINT fk_fact_id;
ALTER TABLE public.ancestor
    ADD CONSTRAINT fk_fact_id
    FOREIGN KEY (fact_id)
    REFERENCES public.fact (fact_id)
    ON DELETE CASCADE;
ALTER TABLE public.ancestor
    DROP CONSTRAINT fk_ancestor_fact_id;
ALTER TABLE public.ancestor
    ADD CONSTRAINT fk_ancestor_fact_id
    FOREIGN KEY (ancestor_fact_id)
    REFERENCES public.fact (fact_id)
    ON DELETE CASCADE;