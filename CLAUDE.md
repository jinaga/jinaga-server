# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Compile TypeScript to dist/
npm test               # Type-check + run Jest tests
npm run test:watch     # Jest in watch mode
npm run clean          # Remove dist/ and integration-test artifacts
npm run integration    # Full build + integration tests (requires Postgres)
npm run debug          # Run debug.ts entry point (configure DB in src/debug.ts first)
```

Run a single test file:
```bash
npx jest test/postgres/postgresReadSpec.ts
```

Run tests matching a pattern:
```bash
npx jest --testNamePattern="should read"
```

## Architecture

Jinaga Server is a middle-tier backend that syncs immutable facts between clients and PostgreSQL. Facts are append-only records (never mutated), signed by user/device identities, and queried via declarative Specifications rather than SQL.

### Layers (top to bottom)

**HTTP** (`src/http/router.ts`) — Express router with three endpoints:
- `POST /jinaga/write` — accept FactEnvelopes from clients
- `POST /jinaga/read` — query facts by Specification
- `POST /jinaga/feed` — long-lived streaming subscription (`application/x-jinaga-feed-stream`)

**Authentication** (`src/authentication/`) — Associates each request with a user/device identity. `AuthenticationDevice` is for server-local operations; `AuthenticationSession` is for per-request user context.

**Authorization** (`src/authorization/authorization-keystore.ts`) — Enforces who can write facts and who can receive them, using `AuthorizationEngine` and `DistributionEngine` from the `jinaga` core library.

**Core** — `FactManager` from the `jinaga` library handles fact storage coordination. This server implements the `Storage` and `Keystore` interfaces that `FactManager` depends on.

**Storage** (`src/postgres/`, `src/memory/`) — Two implementations:
- `PostgresStore` + `PostgresKeystore` — production persistence in PostgreSQL
- `MemoryKeystore` (in-memory) — used in tests and development

### Assembly

`JinagaServer.create(config)` in `src/jinaga-server.ts` wires everything together via dependency injection. It reads the config to determine which storage strategy, fork strategy (pass-through, transient, or persistent for upstream replication), and authorization/distribution rules to use.

### Specification → SQL

The most complex translation in the codebase is in `src/postgres/specification-sql.ts`, which converts a `Specification` object (from the `jinaga` library's query DSL) into SQL JOIN queries. Related: `src/postgres/specification-result-sql.ts` for result projection and `src/postgres/purge-sql.ts` for deletions.

### Feed streaming

`src/http/stream.ts` manages long-lived HTTP connections. When new facts arrive that match a subscription, they're pushed to all connected clients via the queue-based event system.

### Fork strategies

Forks determine how facts propagate upstream:
- `PassThroughFork` — no upstream, single-server
- `TransientFork` — in-memory queue (dev/test)
- `PersistentFork` — `postgres-queue.ts` backed queue for reliable upstream replication to other Jinaga servers

## Key interfaces

- `Storage` (from `jinaga`) — `save()`, `read()`, `feed()`, `remove()`
- `Keystore` (`src/keystore.ts`) — `getOrCreateUserFact()`, `signFacts()`, etc.

## Database schema

`setup.sql` initializes the schema. Key tables: `fact`, `fact_type`, `role`, `ancestor`, `signature`, `public_key`, `user`, `device`. Facts are immutable once written. The `ancestor` table tracks relationships between facts (predecessor/successor edges).

## Testing

Tests live in `test/` matching pattern `**/test/**/*Spec.ts`. Tests use the in-memory keystore and often the actual `PostgresStore` against a real database for integration-level unit tests. See `test/models/blog.ts` for the canonical test data model.
