import express from "express";
import { AddressInfo } from "net";
import { Server } from "http";

import {
    Authorization,
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactEnvelope,
    FactManager,
    FeedCache,
    Invalid,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore, SubscriptionAuthorizer } from "../../src/authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

class Workspace {
    static Type = "ErrorStatus.Workspace" as const;
    public type = Workspace.Type;
    constructor(public owner: User, public identifier: string) { }
}

class Application {
    static Type = "ErrorStatus.Application" as const;
    public type = Application.Type;
    constructor(public workspace: Workspace, public name: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Workspace, w => w.predecessor("owner", User))
    .type(Application, a => a.predecessor("workspace", Workspace))
);

const ownerIdentity = { provider: "mock", id: "owner" };

const requestUser: RequestUser = {
    provider: ownerIdentity.provider,
    id: ownerIdentity.id,
    profile: {} as any
};

async function createHarness() {
    const store = new MemoryStore();
    const keystore = new MemoryKeystore();
    const ownerFact = await keystore.getOrCreateUserFact(ownerIdentity);
    const owner = new User(ownerFact.fields.publicKey);

    const factManager = new FactManager(
        new PassThroughFork(store),
        new ObservableSource(store),
        store,
        new NetworkNoOp(),
        []
    );

    const authorizationRules = new AuthorizationRules(model)
        .any(User.Type)
        .any(Workspace.Type)
        .type(Application, app => app.workspace.owner);
    const authorization = new AuthorizationKeystore(
        factManager, store, keystore, authorizationRules, new DistributionRules([]));
    const router = new HttpRouter(factManager, authorization, new FeedCache(), "*");

    return { store, authorization, router, owner };
}

// A batch holding a successor whose predecessors are in neither the batch nor
// storage. jinaga's AuthorizationEngine detects this in its topological sort
// and reports it as a plain Error.
function unclosedBatch(owner: User): FactEnvelope[] {
    const records = dehydrateFact(new Application(new Workspace(owner, "workspace-1"), "application-1"));
    return records
        .filter(fact => fact.type === Application.Type)
        .map(fact => ({ fact, signatures: [] }));
}

function graphSourceOf(envelopes: FactEnvelope[]) {
    return {
        read: async (onEnvelopes: (envelopes: FactEnvelope[]) => Promise<void>) => {
            await onEnvelopes(envelopes);
        }
    };
}

// A router whose only job is to reject the authorization call with a chosen
// error, so the translation can be exercised for a route whose input grammar
// cannot provoke the error on its own.
function createRouterWithFailingSave(error: Error): HttpRouter {
    const store = new MemoryStore();
    const factManager = new FactManager(
        new PassThroughFork(store), new ObservableSource(store), store, new NetworkNoOp(), []);
    const keystore = new MemoryKeystore();
    const authorization = {
        getOrCreateUserFact: (identity: any) => keystore.getOrCreateUserFact(identity),
        save: () => Promise.reject(error)
    } as unknown as Authorization & SubscriptionAuthorizer;
    return new HttpRouter(factManager, authorization, new FeedCache(), "*");
}

async function captureError(action: () => Promise<unknown>): Promise<any> {
    try {
        await action();
    } catch (error) {
        return error;
    }
    throw new Error("Expected the operation to fail, but it succeeded.");
}

// Issue #182 findings 1 and 2. The translation in router.ts matches jinaga's
// exact English wording, so these cases drive the real AuthorizationEngine
// rather than a hand-written message: if upstream rewords the error, the
// pattern stops matching and these tests fail instead of the classification
// silently regressing to a 500 in production. Replace with instanceof checks
// once jinaga.js#234 lands a typed error.
describe("save authorization error translation", () => {
    it("reports an unresolved predecessor from the real engine as a plain Error", async () => {
        const { authorization, owner } = await createHarness();

        const error = await captureError(() =>
            authorization.save(ownerIdentity, unclosedBatch(owner)));

        // Establishes the untranslated baseline: jinaga signals this client
        // data problem with a bare Error, which handleError would map to 500.
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(Invalid);
        expect(error.message).toContain("one or more predecessors could not be resolved");
    });

    it("translates the unresolved-predecessor shape to Invalid on /save", async () => {
        const { router, owner } = await createHarness();

        const error = await captureError(() =>
            (router as any).save(requestUser, graphSourceOf(unclosedBatch(owner))));

        expect(error).toBeInstanceOf(Invalid);
        expect(error.message).toContain(Application.Type);
        expect(error.message).toContain("were not found in storage and were not included in the request");
    });

    it("translates the unresolved-predecessor shape to Invalid on /write", async () => {
        // The declaration grammar /write accepts cannot express a dangling
        // predecessor, so the engine error is captured from the reachable
        // /save path and replayed here. The route still needs the translation:
        // it makes the same authorization call, and this keeps both routes
        // tracking one upstream wording.
        const { authorization, owner } = await createHarness();
        const engineError = await captureError(() =>
            authorization.save(ownerIdentity, unclosedBatch(owner)));

        const router = createRouterWithFailingSave(engineError);
        const declaration =
            `let workspace: ${Workspace.Type} = { owner: me, identifier: "workspace-1" }\n` +
            `let application: ${Application.Type} = { workspace: workspace, name: "application-1" }\n`;

        const error = await captureError(() => (router as any).write(requestUser, declaration));

        expect(error).toBeInstanceOf(Invalid);
        expect(error.message).toContain("were not found in storage and were not included in the request");
    });

    it("still translates the authorization-rule shape fixed by issue #175", async () => {
        const router = createRouterWithFailingSave(
            new Error("The fact ErrorStatus.Workspace:abc123 is not defined."));

        const error = await captureError(() =>
            (router as any).save(requestUser, graphSourceOf([])));

        expect(error).toBeInstanceOf(Invalid);
        expect(error.message).toContain("ErrorStatus.Workspace:abc123 is required to authorize this save");
    });
});

// Issue #182 findings 3 and 4, exercised over real HTTP so the assertions are
// on the status line a client actually receives.
describe("HTTP status mapping", () => {
    let server: Server;
    let baseUrl: string;

    async function listen(app: express.Express) {
        server = app.listen(0);
        await new Promise<void>(resolve => server.once("listening", () => resolve()));
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
    }

    afterEach(async () => {
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    describe("with no body parser registered", () => {
        beforeEach(async () => {
            const { router } = await createHarness();
            const app = express();
            app.use(router.handler);
            await listen(app);
        });

        // Each of these parses the body synchronously in the handler. Express
        // used to hand the throw to its default error handler, reporting the
        // client's malformed request as a 500.
        it.each([
            ["/write", "text/plain"],
            ["/read", "text/plain"],
            ["/feeds", "text/plain"],
            ["/load", "application/json"]
        ])("answers 400 for %s when the body cannot be read", async (path, contentType) => {
            const response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: { "Content-Type": contentType },
                body: contentType === "application/json" ? "{}" : "anything"
            });

            expect(response.status).toBe(400);
        });

        // The text/plain-only routes name the parser the caller is missing,
        // rather than falling back to parseString's generic content-type
        // message.
        it.each(["/write", "/read"])("names express.text() in the 400 body for %s", async (path) => {
            const response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: "anything"
            });

            expect(await response.text()).toContain("express.text()");
        });

        // Saying what arrived tells the caller which end is misconfigured.
        it("names the Content-Type that was received", async () => {
            const response = await fetch(`${baseUrl}/write`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}"
            });

            expect(await response.text()).toContain("Received Content-Type: application/json");
        });

        it("says so when no Content-Type was received", async () => {
            const response = await fetch(`${baseUrl}/write`, {
                method: "POST",
                body: new Blob(["anything"])
            });

            expect(await response.text()).toContain("No Content-Type header was received");
        });

        it("marks error responses nosniff", async () => {
            const response = await fetch(`${baseUrl}/write`, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: "anything"
            });

            expect(response.status).toBe(400);
            expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        });
    });

    it("answers 500 without echoing the internal error message", async () => {
        const store = new MemoryStore();
        const factManager = new FactManager(
            new PassThroughFork(store), new ObservableSource(store), store, new NetworkNoOp(), []);
        const secret = "connection to postgres://internal-host:5432 refused";
        const failingAuthorization = {
            load: () => Promise.reject(new Error(secret))
        } as unknown as Authorization & SubscriptionAuthorizer;
        const router = new HttpRouter(factManager, failingAuthorization, new FeedCache(), "*");

        const app = express();
        app.use(express.json());
        app.use(router.handler);
        await listen(app);

        const response = await fetch(`${baseUrl}/load`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ references: [] })
        });
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(body).toBe("Internal server error");
        expect(body).not.toContain("internal-host");
        // A plain-text body labelled text/html invites a browser to render it.
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("answers 404 with a distinguishable body for a feed route miss", async () => {
        const { router } = await createHarness();
        const app = express();
        app.use(router.handler);
        await listen(app);

        // A hash the feed cache has never seen resolves to FeedNotFound, which
        // is a different 404 from the route miss below.
        const cacheMiss = await fetch(`${baseUrl}/feeds/unknownhash`);
        expect(cacheMiss.status).toBe(404);
        expect(await cacheMiss.text()).toBe("feed_not_found");
    });
});
