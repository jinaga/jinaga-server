import { Handler, Request } from "express";
import {
    AuthenticationNoOp,
    Authorization,
    AuthorizationNoOp,
    AuthorizationRules,
    FactManager,
    Fork,
    HttpNetwork,
    Jinaga,
    MemoryStore,
    Model,
    Network,
    NetworkNoOp,
    ObservableSource,
    ObservableSourceImpl,
    PassThroughFork,
    Storage,
    SyncStatusNotifier,
    Trace,
    TransientFork,
    UserIdentity,
    WebClient
} from "jinaga";
import { Pool } from "pg";

import { AuthenticationDevice } from "./authentication/authentication-device";
import { AuthenticationSession } from "./authentication/authentication-session";
import { AuthorizationKeystore } from "./authorization/authorization-keystore";
import { NodeHttpConnection } from "./http/node-http";
import { HttpRouter, RequestUser } from "./http/router";
import { Keystore } from "./keystore";
import { MemoryFeedCache } from "./memory/memory-feed-cache";
import { PostgresKeystore } from "./postgres/postgres-keystore";
import { PostgresStore } from "./postgres/postgres-store";


export type JinagaServerConfig = {
    pgStore?: string | Pool,
    pgKeystore?: string | Pool,
    httpEndpoint?: string,
    model?: Model,
    authorization?: (a: AuthorizationRules) => AuthorizationRules,
    httpTimeoutSeconds?: number
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
        const fork = createFork(config, store, syncStatusNotifier);
        const keystore = createKeystore(config, pools);
        const authorizationRules = config.authorization ? config.authorization(new AuthorizationRules(config.model)) : null;
        const authorization = createAuthorization(authorizationRules, store, keystore);
        const feedCache = new MemoryFeedCache();
        const router = new HttpRouter(authorization, feedCache);
        const authentication = createAuthentication(store, keystore, authorizationRules);
        const network = createNetwork(config);
        const factManager = new FactManager(authentication, fork, source, store, network);
        const j: Jinaga = new Jinaga(factManager, syncStatusNotifier);

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
        const store = new PostgresStore(pool);
        return store;
    }
    else {
        return new MemoryStore();
    }
}

function createFork(config: JinagaServerConfig, store: Storage, syncStatusNotifier: SyncStatusNotifier): Fork {
    if (config.httpEndpoint) {
        const httpConnection = new NodeHttpConnection(config.httpEndpoint);
        const httpTimeoutSeconds = config.httpTimeoutSeconds || 5;
        const webClient = new WebClient(httpConnection, syncStatusNotifier, {
            timeoutSeconds: httpTimeoutSeconds
        });
        const fork = new TransientFork(store, webClient);
        return fork;
    }
    else {
        return new PassThroughFork(store);
    }
}

function createKeystore(config: JinagaServerConfig, pools: { [uri: string]: Pool }): Keystore | null {
    const uriOrPool = config.pgKeystore;
    if (uriOrPool) {
        const pool = getPool(uriOrPool, pools);
        const keystore = new PostgresKeystore(pool);
        return keystore;
    }
    else {
        return null;
    }
}

function createAuthorization(authorizationRules: AuthorizationRules | null, store: Storage, keystore: Keystore | null): Authorization {
    if (keystore) {
        const authorization = new AuthorizationKeystore(store, keystore, authorizationRules);
        return authorization;
    }
    else {
        return new AuthorizationNoOp(store);
    }
}

function createAuthentication(store: Storage, keystore: Keystore | null, authorizationRules: AuthorizationRules | null) {
    return keystore ? new AuthenticationDevice(store, keystore, authorizationRules, localDeviceIdentity) : new AuthenticationNoOp();
}

function createNetwork(config: JinagaServerConfig): Network {
    if (config.httpEndpoint) {
        const httpConnection = new NodeHttpConnection(config.httpEndpoint);
        const httpTimeoutSeconds = config.httpTimeoutSeconds || 5;
        const syncStatusNotifier = new SyncStatusNotifier();
        const webClient = new WebClient(httpConnection, syncStatusNotifier, {
            timeoutSeconds: httpTimeoutSeconds
        });
        return new HttpNetwork(webClient);
    }
    else {
        return new NetworkNoOp();
    }
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
    const factManager = new FactManager(authentication, fork, observableSource, store, network);
    const j = new Jinaga(factManager, syncStatusNotifier);
    await callback(j);
}