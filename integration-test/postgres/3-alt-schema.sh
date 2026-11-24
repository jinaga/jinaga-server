#!/bin/bash
set -e

# A second schema holding the same tables as `public`, so a test can show that
# saves to two different schemas do not wait on each other (issue #252). Each
# schema has its own `fact_id` sequence, so the save lock that orders one
# schema's ids has no reason to order another's.
#
# The tables are copied from the public schema's own definitions, so the two
# cannot drift as `1-setup.sql` changes. `LIKE` copies a serial column's
# default but not its sequence, so each copied serial column is given one of
# its own: two schemas sharing a sequence would be the thing under test.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$APP_DATABASE" <<-EOSQL
    CREATE SCHEMA alt;

    CREATE TABLE alt.fact_type (LIKE public.fact_type INCLUDING ALL);
    CREATE TABLE alt.role (LIKE public.role INCLUDING ALL);
    CREATE TABLE alt.fact (LIKE public.fact INCLUDING ALL);
    CREATE TABLE alt.edge (LIKE public.edge INCLUDING ALL);
    CREATE TABLE alt.ancestor (LIKE public.ancestor INCLUDING ALL);
    CREATE TABLE alt.public_key (LIKE public.public_key INCLUDING ALL);
    CREATE TABLE alt.signature (LIKE public.signature INCLUDING ALL);
    CREATE TABLE alt.bookmark (LIKE public.bookmark INCLUDING ALL);
    CREATE TABLE alt."user" (LIKE public."user" INCLUDING ALL);

    CREATE SEQUENCE alt.fact_type_fact_type_id_seq OWNED BY alt.fact_type.fact_type_id;
    ALTER TABLE alt.fact_type ALTER COLUMN fact_type_id SET DEFAULT nextval('alt.fact_type_fact_type_id_seq');
    CREATE SEQUENCE alt.role_role_id_seq OWNED BY alt.role.role_id;
    ALTER TABLE alt.role ALTER COLUMN role_id SET DEFAULT nextval('alt.role_role_id_seq');
    CREATE SEQUENCE alt.fact_fact_id_seq OWNED BY alt.fact.fact_id;
    ALTER TABLE alt.fact ALTER COLUMN fact_id SET DEFAULT nextval('alt.fact_fact_id_seq');
    CREATE SEQUENCE alt.public_key_public_key_id_seq OWNED BY alt.public_key.public_key_id;
    ALTER TABLE alt.public_key ALTER COLUMN public_key_id SET DEFAULT nextval('alt.public_key_public_key_id_seq');

    GRANT USAGE ON SCHEMA alt TO $APP_USERNAME;
    GRANT SELECT,INSERT ON TABLE alt.fact_type TO $APP_USERNAME;
    GRANT SELECT,INSERT ON TABLE alt.role TO $APP_USERNAME;
    GRANT SELECT,INSERT,DELETE ON TABLE alt.fact TO $APP_USERNAME;
    GRANT SELECT,INSERT,DELETE ON TABLE alt.edge TO $APP_USERNAME;
    GRANT SELECT,INSERT,DELETE ON TABLE alt.ancestor TO $APP_USERNAME;
    GRANT SELECT,INSERT ON TABLE alt.public_key TO $APP_USERNAME;
    GRANT SELECT,INSERT,DELETE ON TABLE alt.signature TO $APP_USERNAME;
    GRANT SELECT,INSERT ON TABLE alt."user" TO $APP_USERNAME;
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE alt.bookmark TO $APP_USERNAME;
    GRANT SELECT,USAGE ON ALL SEQUENCES IN SCHEMA alt TO $APP_USERNAME;
EOSQL
