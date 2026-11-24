#!/bin/bash
set -e

docker build -t jinaga-postgres-fact-keystore ./postgres

mkdir -p ./jinaga-test/jinaga-server
cp -R ../dist ./jinaga-test/jinaga-server/dist
cp ../package.json ./jinaga-test/jinaga-server/package.json
# The schema and the repair script, so a test can run the real files rather
# than a copy of their statements. They go inside jinaga-server/, which the
# image already copies and `npm run clean` already removes.
cp ../setup.sql ./jinaga-test/jinaga-server/setup.sql
cp ../repair-edge-order.sql ./jinaga-test/jinaga-server/repair-edge-order.sql
docker build -t jinaga-test ./jinaga-test

cleanup() {
    docker compose down -v
}

trap cleanup EXIT

docker compose up --exit-code-from jinaga-test --renew-anon-volumes
