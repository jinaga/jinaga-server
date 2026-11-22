import express from "express";
import { Server } from "http";
import { AddressInfo } from "net";

import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactEnvelope,
    FactManager,
    FactRecord,
    FactReference,
    FeedCache,
    GraphSerializer,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

class Workspace {
    static Type = "SaveLineLimit.Workspace" as const;
    public type = Workspace.Type;
    constructor(public owner: User, public identifier: string) { }
}

class Application {
    static Type = "SaveLineLimit.Application" as const;
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

const MaxSaveLineBytes = 64 * 1024;

function referenceOf(record: FactRecord): FactReference {
    return { type: record.type, hash: record.hash };
}

// Issue #169, criterion 3. The graph content type reads the request stream
// without a body parser in front of it, so the line reader's limit is what
// answers an oversized line. Both tests send the same graph body, so the
// refusal is attributable to the one line that was appended and nothing else.
describe("POST /save with a graph line over the limit", () => {
    let server: Server;
    let baseUrl: string;
    let store: MemoryStore;
    let graphBody: string;
    let references: FactReference[];

    beforeEach(async () => {
        store = new MemoryStore();
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
        const router = new HttpRouter(
            factManager, authorization, new FeedCache(), "*", {}, MaxSaveLineBytes);

        const app = express();
        // The route reads the identity off the request, which an authentication
        // layer would have put there.
        app.use((req, _res, next) => {
            (req as any).user = requestUser;
            next();
        });
        app.use(router.handler);

        server = app.listen(0);
        await new Promise<void>(resolve => server.once("listening", () => resolve()));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        // Round-trip real facts through the wire protocol, so the body the
        // tests send is one the server would otherwise accept.
        const records = dehydrateFact(
            new Application(new Workspace(owner, "workspace-1"), "application-1"));
        references = records.map(referenceOf);
        const envelopes: FactEnvelope[] = records.map(fact => ({ fact, signatures: [] }));
        const chunks: string[] = [];
        new GraphSerializer(chunk => chunks.push(chunk)).serialize(envelopes);
        graphBody = chunks.join("");
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    async function postGraph(body: string): Promise<Response> {
        return await fetch(`${baseUrl}/save`, {
            method: "POST",
            headers: { "Content-Type": "application/x-jinaga-graph-v1" },
            body
        });
    }

    it("saves the graph body on its own", async () => {
        const response = await postGraph(graphBody);

        expect(response.status).toBe(201);
        // Establishes that the body is saveable, so the refusal below is
        // attributable to the oversized line rather than to the graph.
        expect(await store.whichExist(references)).toHaveLength(references.length);
        expect(references.length).toBeGreaterThan(1);
    });

    it("answers 413 and saves no fact when one line exceeds the limit", async () => {
        const oversized = "A".repeat(MaxSaveLineBytes + 1);
        const response = await postGraph(`${graphBody}${oversized}`);
        const text = await response.text();

        expect(response.status).toBe(413);
        // The body names the limit that was passed, not anything the client
        // sent, and is marked so a browser will not sniff it as markup.
        expect(text).toContain(String(MaxSaveLineBytes));
        expect(response.headers.get("content-type")).toContain("text/plain");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");

        // The facts ahead of the oversized line parsed cleanly and were held
        // for the single authorization call that never ran.
        expect(await store.whichExist(references)).toEqual([]);
    });
});
