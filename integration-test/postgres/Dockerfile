FROM postgres:17.2-alpine3.21

COPY ./0-init-app-db.sh /docker-entrypoint-initdb.d/
COPY ./1-setup.sql /docker-entrypoint-initdb.d/
COPY ./2-grant.sh /docker-entrypoint-initdb.d/