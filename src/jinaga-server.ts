import { Handler, Request } from "express";
import {
    AuthenticationNoOp,
    Authorization,
    AuthorizationNoOp,
    AuthorizationRules,
    DistributionRules,
    FactManager,
    FeedCache,
    Jinaga,
    MemoryStore,
    Model,
    NetworkNoOp,
    ObservableSource,
    ObservableSourceImpl,
    PassThroughFork,
    Storage,
    SyncStatusNotifier,
    Trace,
    UserIdentity
} from "jinaga";
import { Pool } from "pg";

import { AuthenticationDevice } from "./authentication/authentication-device";
import { AuthenticationSession } from "./authentication/authentication-session";
import { AuthorizationKeystore } from "./authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "./http/router";
import { Keystore } from "./keystore";
import { PostgresKeystore } from "./postgres/postgres-keystore";
import { PostgresStore } from "./postgres/postgres-store";


export type JinagaServerConfig = {
    pgStore?: string | Pool,
    pgStoreSchema?: string,
    pgKeystore?: string | Pool,
    pgKeystoreSchema?: string,
    model?: Model,
    authorization?: (a: AuthorizationRules) => AuthorizationRules,
    distribution?: (d: DistributionRules) => DistributionRules,
};

export type JinagaServerInstance = {
    handler: Handler,
    j: Jinaga,
    withSession: (req: Request, callback: ((j: Jinaga) => Promise<void>)) => Promise<void>,
    close: () => Promise<void>
};

const localDeviceIdentity = {
    provider: 'jinaga',
    id: 'local'
};

export class JinagaServer {
    static create(config: JinagaServerConfig): JinagaServerInstance {
        const syncStatusNotifier = new SyncStatusNotifier();
        const pools: { [uri: string]: Pool } = {};
        const store = createStore(config, pools);
        const source = new ObservableSourceImpl(store);
        const fork = new PassThroughFork(store);
        const keystore = createKeystore(config, pools);
        const authorizationRules = config.authorization ? config.authorization(new AuthorizationRules(config.model)) : null;
        const distributionRules = config.distribution ? config.distribution(new DistributionRules([])) : null;
        const feedCache = new FeedCache();
        const authentication = createAuthentication(store, keystore, authorizationRules);
        const network = new NetworkNoOp();
        const factManager = new FactManager(fork, source, store, network);
        const authorization = createAuthorization(authorizationRules, distributionRules, factManager, store, keystore);
        const router = new HttpRouter(factManager, authorization, feedCache);
        const j: Jinaga = new Jinaga(authentication, factManager, syncStatusNotifier);

        async function close() {
            for (const pool of Object.values(pools)) {
                await pool.end();
            }
        }
        return {
            handler: router.handler,
            j,
            withSession: (req, callback) => {
                return withSession(store, keystore, authorizationRules, req, callback);
            },
            close
        }
    }
}

function createStore(config: JinagaServerConfig, pools: { [uri: string]: Pool }): Storage {
    if (config.pgStore) {
        const pool = getPool(config.pgStore, pools);
        const store = new PostgresStore(pool, validateSchema(config.pgStoreSchema));
        return store;
    }
    else {
        return new MemoryStore();
    }
}

function createKeystore(config: JinagaServerConfig, pools: { [uri: string]: Pool }): Keystore | null {
    const uriOrPool = config.pgKeystore;
    if (uriOrPool) {
        const pool = getPool(uriOrPool, pools);
        const keystore = new PostgresKeystore(pool, validateSchema(config.pgKeystoreSchema));
        return keystore;
    }
    else {
        return null;
    }
}

function createAuthorization(authorizationRules: AuthorizationRules | null, distributionRules: DistributionRules | null, factManager: FactManager, store: Storage, keystore: Keystore | null): Authorization {
    if (keystore) {
        const authorization = new AuthorizationKeystore(factManager, store, keystore, authorizationRules, distributionRules);
        return authorization;
    }
    else {
        return new AuthorizationNoOp(factManager, store);
    }
}

function createAuthentication(store: Storage, keystore: Keystore | null, authorizationRules: AuthorizationRules | null) {
    return keystore ? new AuthenticationDevice(store, keystore, authorizationRules, localDeviceIdentity) : new AuthenticationNoOp();
}

function getPool(uriOrPool: string | Pool, pools: { [uri: string]: Pool; }): Pool {
    if (typeof uriOrPool === 'string') {
        const uri = uriOrPool;
        if (!pools[uri]) {
            pools[uri] = createPool(uri);
        }
        return pools[uri];
    }
    else {
        return uriOrPool;
    }
}

function createPool(postgresUri: string): Pool {
    const postgresPool = new Pool({
        connectionString: postgresUri,
        idleTimeoutMillis: process.env.POSTGRES_IDLE_TIMEOUT_MILLIS ?
            parseInt(process.env.POSTGRES_IDLE_TIMEOUT_MILLIS) :
            30000,
        log(...messages) {
            Trace.info(messages.join(' '));
        },
    });

    tracePool(postgresPool);

    return postgresPool;
}

export function tracePool(postgresPool: Pool) {
    postgresPool.on('acquire', (client) => {
        Trace.metric('Postgres acquired', poolMetrics());
    });
    postgresPool.on('connect', (client) => {
        Trace.metric('Postgres connected', poolMetrics());
    });
    postgresPool.on('remove', (client) => {
        Trace.metric('Postgres disconnected', poolMetrics());
    });
    postgresPool.on('error', (err, client) => {
        Trace.error(err);
    });

    function poolMetrics() {
        return {
            total: postgresPool.totalCount,
            idle: postgresPool.idleCount,
            waiting: postgresPool.waitingCount
        };
    }
}

async function withSession(store: Storage, keystore: Keystore | null, authorizationRules: AuthorizationRules | null, req: Request, callback: ((j: Jinaga) => Promise<void>)) {
    const user = <RequestUser>req.user;
    const userIdentity: UserIdentity = {
        provider: user.provider,
        id: user.id
    }
    const authentication = keystore ? new AuthenticationSession(store, keystore, authorizationRules, userIdentity, user.profile.displayName, localDeviceIdentity) : new AuthenticationNoOp();
    const syncStatusNotifier = new SyncStatusNotifier();
    const fork = new PassThroughFork(store);
    const observableSource = new ObservableSource(store);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observableSource, store, network);
    const j = new Jinaga(authentication, factManager, syncStatusNotifier);
    await callback(j);
}

function validateSchema(schema: string | undefined): string {
    if (!schema) {
        return "public";
    }

    // Verify that the schema is a valid Postgres schema name.
    // https://www.postgresql.org/docs/9.1/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS
    if (!/^[a-z_][a-z0-9_$]*$/.test(schema)) {
        throw new Error(`Invalid schema name: ${schema}. Schema names must start with a letter or underscore, and contain only letters, numbers, and underscores.`);
    }

    return schema;
}
