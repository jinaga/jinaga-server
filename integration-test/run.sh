#!/bin/bash
set -e

docker build -t jinaga-postgres-fact-keystore ./postgres

mkdir -p ./jinaga-test/jinaga-server
cp -R ../dist ./jinaga-test/jinaga-server/dist
cp ../package.json ./jinaga-test/jinaga-server/package.json
docker build -t jinaga-test ./jinaga-test

cleanup() {
    docker compose down -v
}

trap cleanup EXIT

docker compose up --exit-code-from jinaga-test --renew-anon-volumes
