import { Handler, Request } from "express";
import {
    AuthenticationNoOp,
    Authorization,
    AuthorizationNoOp,
    AuthorizationRules,
    DistributionRules,
    FactFeed,
    FactManager,
    FactReference,
    FeedCache,
    FetchConnection,
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
    PersistentFork,
    PurgeConditions,
    ReferencesByName,
    Specification,
    Storage,
    SyncStatusNotifier,
    Trace,
    TransientFork,
    UserIdentity,
    validatePurgeSpecification,
    WebClient
} from "jinaga";
import { Pool } from "pg";

import { AuthenticationDevice } from "./authentication/authentication-device";
import { AuthenticationSession } from "./authentication/authentication-session";
import { AuthorizationKeystore, DistributionBranchesResult, FeedResult, SubscriptionAuthorizer } from "./authorization/authorization-keystore";
import { FeedStreamSessionConfig } from "./feeds/feed-stream-session";
import { HttpRouter, RequestUser } from "./http/router";
import { Keystore } from "./keystore";
import { PostgresKeystore } from "./postgres/postgres-keystore";
import { PostgresQueue } from "./postgres/postgres-queue";
import { PostgresStore } from "./postgres/postgres-store";


export type JinagaServerConfig = {
    pgStore?: string | Pool,
    pgStoreSchema?: string,
    pgKeystore?: string | Pool,
    pgKeystoreSchema?: string,
    upstreamReplicators?: string[],
    httpTimeoutSeconds?: number,
    queueProcessingDelayMs?: number,
    model?: Model,
    authorization?: (a: AuthorizationRules) => AuthorizationRules,
    distribution?: (d: DistributionRules) => DistributionRules,
    purgeConditions?: (p: PurgeConditions) => PurgeConditions,
    origin?: string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void),
    /**
     * Tuning for the per-connection feed streaming session
     * (/feeds/:hash with Accept: application/x-jinaga-feed-stream).
     * See FeedStreamSessionConfig for the available limits and defaults.
     */
    feedStream?: Partial<FeedStreamSessionConfig>
};

export type JinagaServerInstance = {
    handler: Handler,
    j: Jinaga,
    factManager: FactManager,
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
        const pool = makePool(config, pools);
        const schema = validateSchema(config.pgStoreSchema);
        const store = createStore(pool, schema);
        const source = new ObservableSourceImpl(store);
        const webClient = createWebClient(config, syncStatusNotifier);
        const fork = createFork(config, webClient, store, pool, schema);
        const keystore = createKeystore(config, pools);
        const authorizationRules = config.authorization ? config.authorization(new AuthorizationRules(config.model)) : null;
        const distributionRules = config.distribution ? config.distribution(new DistributionRules([])) : null;
        const feedCache = new FeedCache();
        const authentication = createAuthentication(store, keystore, authorizationRules);
        const network = createNetwork(webClient);
        const purgeConditions = createPurgeConditions(config);
        const factManager = new FactManager(fork, source, store, network, purgeConditions);
        const authorization = createAuthorization(authorizationRules, distributionRules, factManager, store, keystore);
        const router = new HttpRouter(factManager, authorization, feedCache, config.origin || '*', config.feedStream || {});
        const j: Jinaga = new Jinaga(authentication, factManager, syncStatusNotifier);

        async function close() {
            for (const pool of Object.values(pools)) {
                await pool.end();
            }
        }
        return {
            handler: router.handler,
            j,
            factManager,
            withSession: (req, callback) => {
                return withSession(store, keystore, authorizationRules, purgeConditions, req, callback);
            },
            close
        }
    }
}

function makePool(config: JinagaServerConfig, pools: { [uri: string]: Pool }): Pool | undefined {
    const uri = config.pgStore;
    if (uri) {
        return getPool(uri, pools);
    }
    else {
        return undefined;
    }
}

function createStore(pool: Pool | undefined, schema: string): Storage {
    if (pool) {
        return new PostgresStore(pool, schema);
    }
    else {
        return new MemoryStore();
    }
}

function createWebClient(
    config: JinagaServerConfig,
    syncStatusNotifier: SyncStatusNotifier
): WebClient | null {
    if (config.upstreamReplicators && config.upstreamReplicators.length > 0) {
        // TODO: Handle multiple upstream replicators
        // TODO: Handle authentication
        const httpEndpoint = config.upstreamReplicators[0];
        const getHeaders = () => Promise.resolve({});
        const reauthenticate = () => Promise.resolve(false);
        const httpConnection = new FetchConnection(httpEndpoint, getHeaders, reauthenticate);
        const httpTimeoutSeconds = config.httpTimeoutSeconds || 30;
        const webClient = new WebClient(httpConnection, syncStatusNotifier, {
            timeoutSeconds: httpTimeoutSeconds
        });
        return webClient;
    }
    else {
        return null;
    }
}

function createFork(
    config: JinagaServerConfig,
    webClient: WebClient | null,
    store: Storage,
    pool: Pool | undefined,
    schema: string
): Fork {
    if (webClient) {
        if (pool) {
            const queue = new PostgresQueue(pool, schema);
            const fork = new PersistentFork(store, queue, webClient, config.queueProcessingDelayMs || 100);
            fork.initialize();
            return fork;
        }
        else {
            const fork = new TransientFork(store, webClient);
            return fork;
        }
    }
    else {
        const fork = new PassThroughFork(store);
        return fork;
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

class AuthorizationNoOpWithSubscriptions extends AuthorizationNoOp implements SubscriptionAuthorizer {
    async verifyDistributionOrIntersect(
        _userIdentity: UserIdentity | null,
        specification: Specification,
        namedStart: ReferencesByName
    ): Promise<DistributionBranchesResult> {
        const start = specification.given.map(g => namedStart[g.label.name]);
        return { type: "success", branches: [{ start, specification }] };
    }

    feedPreVerified(
        userIdentity: UserIdentity | null,
        specification: Specification,
        start: FactReference[],
        bookmark: string
    ): Promise<FactFeed> {
        return this.feed(userIdentity!, specification, start, bookmark);
    }

    async feedWithDistribution(
        userIdentity: UserIdentity | null,
        specification: Specification,
        start: FactReference[],
        bookmark: string
    ): Promise<FeedResult> {
        const feed = await this.feed(userIdentity!, specification, start, bookmark);
        return { type: "success", feed };
    }
}

function createAuthorization(authorizationRules: AuthorizationRules | null, distributionRules: DistributionRules | null, factManager: FactManager, store: Storage, keystore: Keystore | null): Authorization & SubscriptionAuthorizer {
    if (keystore) {
        const authorization = new AuthorizationKeystore(factManager, store, keystore, authorizationRules, distributionRules);
        return authorization;
    }
    else {
        return new AuthorizationNoOpWithSubscriptions(factManager, store);
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

type PoolSettingDeclaration = {
    variable: string,
    defaultValue: number,
    minimum: number
};

// The settings of a pool that this server builds for itself, each named by the
// environment variable that sets it. A pool the caller supplies is used as
// given, so none of these applies to it.
const poolSettingDeclarations = {
    // A pool of zero connections can serve nothing, so one is the minimum.
    max: { variable: "POSTGRES_POOL_MAX", defaultValue: 10, minimum: 1 },
    idleTimeoutMillis: { variable: "POSTGRES_IDLE_TIMEOUT_MILLIS", defaultValue: 30000, minimum: 0 },
    // Zero means wait forever for a connection to come free.
    connectionTimeoutMillis: { variable: "POSTGRES_CONNECTION_TIMEOUT_MILLIS", defaultValue: 0, minimum: 0 }
} satisfies { [setting: string]: PoolSettingDeclaration };

type PoolSettings = {
    [setting in keyof typeof poolSettingDeclarations]: number
};

// The one rule by which every pool setting is read from the environment. An
// absent or empty variable takes the default; anything that is not an integer
// at or above the setting's minimum is refused rather than resolved, so the
// environment either names a pool that can be built or no pool at all.
function readPoolSetting({ variable, defaultValue, minimum }: PoolSettingDeclaration): number {
    const value = process.env[variable];
    if (value === undefined || value.trim() === '') {
        return defaultValue;
    }
    const parsed = /^\d+$/.test(value.trim()) ? parseInt(value.trim(), 10) : NaN;
    if (isNaN(parsed) || parsed < minimum) {
        throw new Error(`The environment variable ${variable} is set to ${JSON.stringify(value)}, which is not an integer of at least ${minimum}.`);
    }
    return parsed;
}

function readPoolSettings(): PoolSettings {
    return {
        max: readPoolSetting(poolSettingDeclarations.max),
        idleTimeoutMillis: readPoolSetting(poolSettingDeclarations.idleTimeoutMillis),
        connectionTimeoutMillis: readPoolSetting(poolSettingDeclarations.connectionTimeoutMillis)
    };
}

function createPool(postgresUri: string): Pool {
    const settings = readPoolSettings();
    const postgresPool = new Pool({
        connectionString: postgresUri,
        ...settings
    });

    Trace.info(`Postgres pool created with max ${settings.max}, idleTimeoutMillis ${settings.idleTimeoutMillis}, connectionTimeoutMillis ${settings.connectionTimeoutMillis}`);

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

async function withSession(store: Storage, keystore: Keystore | null, authorizationRules: AuthorizationRules | null, purgeConditions: Specification[], req: Request, callback: ((j: Jinaga) => Promise<void>)) {
    const user = <RequestUser>(req as any).user;
    const userIdentity: UserIdentity = {
        provider: user.provider,
        id: user.id
    }
    const authentication = keystore ? new AuthenticationSession(store, keystore, authorizationRules, userIdentity, user.profile.displayName, localDeviceIdentity) : new AuthenticationNoOp();
    const syncStatusNotifier = new SyncStatusNotifier();
    const fork = new PassThroughFork(store);
    const observableSource = new ObservableSource(store);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observableSource, store, network, purgeConditions);
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

function createPurgeConditions(
    config: JinagaServerConfig
): Specification[] {
    if (config.purgeConditions) {
        var specifications = config.purgeConditions(new PurgeConditions([])).specifications;
        var validationFailures: string[] = specifications.map(specification =>
            validatePurgeSpecification(specification)).flat();
        if (validationFailures.length > 0) {
            throw new Error(validationFailures.join("\n"));
        }
        return specifications;
    }
    else {
        return [];
    }
}

function createNetwork(
    webClient: WebClient | null
): Network {
    if (webClient) {
        const network = new HttpNetwork(webClient);
        return network;
    }
    else {
        return new NetworkNoOp();
    }
}
