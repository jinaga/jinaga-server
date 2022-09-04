import { Handler, Request } from "express";
import {
    Authorization,
    AuthorizationNoOp,
    AuthorizationRules,
    Cache,
    Fork,
    Jinaga,
    MemoryStore,
    ObservableSource,
    ObservableSourceImpl,
    PassThroughFork,
    Storage,
    SyncStatusNotifier,
    TransientFork,
    UserIdentity,
    WebClient,
} from "jinaga";

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
    pgStore?: string,
    pgKeystore?: string,
    httpEndpoint?: string,
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
        const store = createStore(config);
        const source = new ObservableSourceImpl(store);
        const fork = createFork(config, source, syncStatusNotifier);
        const keystore = new PostgresKeystore(config.pgKeystore);
        const authorizationRules = config.authorization ? config.authorization(new AuthorizationRules()) : null;
        const authorization = createAuthorization(authorizationRules, fork, keystore);
        const feedCache = new MemoryFeedCache();
        const router = new HttpRouter(authorization, feedCache);
        const authentication = new AuthenticationDevice(fork, keystore, localDeviceIdentity);
        const memory = new MemoryStore();
        const j: Jinaga = new Jinaga(authentication, memory, syncStatusNotifier);

        async function close() {
            await keystore.close();
            await store.close();
        }
        return {
            handler: router.handler,
            j,
            withSession: (req, callback) => {
                return withSession(source, keystore, authorizationRules, req, callback);
            },
            close
        }
    }
}

function createStore(config: JinagaServerConfig): Storage {
    if (config.pgStore) {
        const store = new PostgresStore(config.pgStore);
        const cache = new Cache(store);
        return cache;
    }
    else {
        return new MemoryStore();
    }
}

function createFork(config: JinagaServerConfig, feed: ObservableSource, syncStatusNotifier: SyncStatusNotifier): Fork {
    if (config.httpEndpoint) {
        const httpConnection = new NodeHttpConnection(config.httpEndpoint);
        const httpTimeoutSeconds = config.httpTimeoutSeconds || 5;
        const webClient = new WebClient(httpConnection, syncStatusNotifier, {
            timeoutSeconds: httpTimeoutSeconds
        });
        const fork = new TransientFork(feed, webClient);
        return fork;
    }
    else {
        return new PassThroughFork(feed);
    }
}

function createAuthorization(authorizationRules: AuthorizationRules | null, feed: ObservableSource, keystore: Keystore | null): Authorization {
    if (keystore) {
        const authorization = new AuthorizationKeystore(feed, keystore, authorizationRules);
        return authorization;
    }
    else {
        return new AuthorizationNoOp(feed);
    }
}

async function withSession(feed: ObservableSource, keystore: Keystore, authorizationRules: AuthorizationRules | null, req: Request, callback: ((j: Jinaga) => Promise<void>)) {
    const user = <RequestUser>req.user;
    const userIdentity: UserIdentity = {
        provider: user.provider,
        id: user.id
    }
    const authentication = new AuthenticationSession(feed, keystore, authorizationRules, userIdentity, user.profile.displayName, localDeviceIdentity);
    const syncStatusNotifier = new SyncStatusNotifier();
    const j = new Jinaga(authentication, new MemoryStore(), syncStatusNotifier);
    await callback(j);
}