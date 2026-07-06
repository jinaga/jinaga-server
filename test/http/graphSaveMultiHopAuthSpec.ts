import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    DistributionRules,
    FactEnvelope,
    FactManager,
    FactRecord,
    FeedCache,
    GraphDeserializer,
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

class Filler {
    static Type = "GraphSave.Filler" as const;
    public type = Filler.Type;
    constructor(public value: number) { }
}

class Workspace {
    static Type = "GraphSave.Workspace" as const;
    public type = Workspace.Type;
    constructor(public owner: User, public identifier: string) { }
}

class Application {
    static Type = "GraphSave.Application" as const;
    public type = Application.Type;
    constructor(public workspace: Workspace, public name: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Filler)
    .type(Workspace, w => w.predecessor("owner", User))
    .type(Application, a => a.predecessor("workspace", Workspace))
);

function createReadLine(input: string) {
    const lines = input.split("\n");
    if (lines[lines.length - 1] === "") {
        lines.pop();
    }
    return async () => {
        const line = lines.shift();
        return line !== undefined ? line : null;
    };
}

// Regression test for issue #175: HttpRouter.save() used to pass its
// authorization call directly as GraphDeserializer's per-flush callback, so
// a graph body that split across flush boundaries (every 20 facts)
// authorized each flush independently. A fact whose rule needs a multi-hop
// predecessor chain landing in an earlier flush then failed with
// "The fact <type>:<hash> is not defined." (surfaced to clients as a 500). This drives
// the real application/x-jinaga-graph-v1 code path end to end.
describe("POST /save with a multi-flush graph body", () => {
    it("authorizes a fact whose multi-hop predecessors landed in a prior flush batch", async () => {
        const store = new MemoryStore();
        const keystore = new MemoryKeystore();
        const ownerIdentity = { provider: "mock", id: "owner" };
        const ownerFact = await keystore.getOrCreateUserFact(ownerIdentity);
        const owner = new User(ownerFact.fields.publicKey);

        const fork = new PassThroughFork(store);
        const observable = new ObservableSource(store);
        const network = new NetworkNoOp();
        const factManager = new FactManager(fork, observable, store, network, []);

        const authorizationRules = new AuthorizationRules(model)
            .any(Filler.Type)
            .any(User.Type)
            .any(Workspace.Type)
            .type(Application, app => app.workspace.owner);
        const distributionRules = new DistributionRules([]);
        const authorization = new AuthorizationKeystore(
            factManager, store, keystore, authorizationRules, distributionRules);
        const feedCache = new FeedCache();
        const router = new HttpRouter(factManager, authorization, feedCache, "*");

        const requestUser: RequestUser = {
            provider: ownerIdentity.provider,
            id: ownerIdentity.id,
            profile: {} as any
        };

        // Pad the graph with enough leading facts that the real predecessor
        // chain (owner -> workspace -> application) crosses the
        // GraphDeserializer's default 20-fact flush threshold, landing
        // Application in a later flush than its predecessors.
        const fillerRecords: FactRecord[] = [];
        for (let i = 0; i < 18; i++) {
            fillerRecords.push(...dehydrateFact(new Filler(i)));
        }
        const chainRecords = dehydrateFact(new Application(new Workspace(owner, "workspace-1"), "application-1"));

        const allRecords = [...fillerRecords, ...chainRecords];
        expect(allRecords.length).toBeGreaterThan(20);
        expect(allRecords[allRecords.length - 1].type).toBe(Application.Type);

        const envelopes: FactEnvelope[] = allRecords.map(fact => ({ fact, signatures: [] }));

        // Round-trip through the wire protocol so the test exercises the
        // real GraphDeserializer flush boundary, not a hand-picked batch.
        const lines: string[] = [];
        new GraphSerializer(chunk => lines.push(chunk)).serialize(envelopes);
        const wireText = lines.join("");
        const readLine = createReadLine(wireText);
        const graphSource = new GraphDeserializer(readLine);

        await expect((router as any).save(requestUser, graphSource)).resolves.toBeUndefined();

        const applicationRecord = chainRecords.find(f => f.type === Application.Type)!;
        const saved = await store.whichExist([{ type: Application.Type, hash: applicationRecord.hash }]);
        expect(saved.length).toBe(1);
    });
});
