     SELECT f4.hash AS hash4, f4.fact_id AS id4, f4.data AS data4
          , f7.hash AS hash7, f7.fact_id AS id7, f7.data AS data7
          , f9.hash AS hash9, f9.fact_id AS id9, f9.data AS data9
       FROM public.fact f1
       JOIN public.edge e1
         ON e1.predecessor_fact_id = f1.fact_id
        AND e1.role_id = $3
       JOIN public.fact f3
         ON f3.fact_id = e1.successor_fact_id
       JOIN public.edge e2
         ON e2.predecessor_fact_id = f3.fact_id
        AND e2.role_id = $4
       JOIN public.fact f4
         ON f4.fact_id = e2.successor_fact_id
       JOIN public.edge e5
         ON e5.predecessor_fact_id = f4.fact_id
        AND e5.role_id = $7
       JOIN public.fact f7
         ON f7.fact_id = e5.successor_fact_id
       JOIN public.edge e6
         ON e6.successor_fact_id = f7.fact_id
        AND e6.role_id = $10
       JOIN public.fact f2
         ON f2.fact_id = e6.predecessor_fact_id
       JOIN public.edge e8
         ON e8.predecessor_fact_id = f4.fact_id
        AND e8.role_id = $12
       JOIN public.fact f9
         ON f9.fact_id = e8.successor_fact_id
      WHERE 1=1
       AND f1.fact_type_id = $1
        AND f1.hash = $2
        AND f2.fact_type_id = $8
        AND f2.hash = $9
        AND NOT EXISTS (SELECT 1
                          FROM public.edge e3
                          JOIN public.fact f5
                            ON f5.fact_id = e3.successor_fact_id
                         WHERE 1=1
                           AND e3.predecessor_fact_id = f4.fact_id
                           AND e3.role_id = $5)
        AND NOT EXISTS (SELECT 1
                          FROM public.edge e7
                          JOIN public.fact f8
                            ON f8.fact_id = e7.successor_fact_id
                         WHERE 1=1
                           AND e7.predecessor_fact_id = f7.fact_id
                           AND e7.role_id = $11)
   ORDER BY f4.fact_id ASC, f7.fact_id ASC, f9.fact_id ASC