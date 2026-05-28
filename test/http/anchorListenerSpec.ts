import {
    buildModel,
    dehydrateFact,
    FactManager,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    Specification,
    User
} from "jinaga";

// Validates the same listener pattern HttpRouter.streamFeed uses to wake
// subscriptions when an anchor (given) fact finally arrives at the
// server. The pattern is: register a SpecificationListener on a spec
// whose only given matches the anchor's type and whose matches array is
// empty, then filter the projected results by the anchor hash.
class Note {
    public static Type = "anchor.Note" as const;
    public type = Note.Type;
    constructor(public author: User, public body: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Note, m => m.predecessor("author", User))
);

function makeFactManager() {
    const storage = new MemoryStore();
    const fork = new PassThroughFork(storage);
    const observable = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observable, storage, network, []);
    return { storage, factManager };
}

describe("anchor listener pattern", () => {
    it("fires when a fact matching the anchor's (type, hash) is saved", async () => {
        const { factManager } = makeFactManager();

        const author = new User("anchor-author-key");
        const authorRef = dehydrateFact(author)[0];

        let firedFor: string | null = null;
        const anchorSpec: Specification = {
            given: [{ label: { name: "x", type: authorRef.type }, conditions: [] }],
            matches: [],
            projection: { type: "fact", label: "x" }
        };
        const listener = factManager.addSpecificationListener(anchorSpec, async (results) => {
            for (const r of results) {
                const ref = (r.tuple as any).x;
                if (ref && ref.type === authorRef.type && ref.hash === authorRef.hash) {
                    firedFor = ref.hash;
                }
            }
        });

        await factManager.save(dehydrateFact(author).map(f => ({ fact: f, signatures: [] })));

        factManager.removeSpecificationListener(listener);
        expect(firedFor).toBe(authorRef.hash);
    });

    it("does not fire for facts of an unrelated type", async () => {
        const { factManager } = makeFactManager();

        const author = new User("anchor-author-key");
        const note = new Note(author, "hi");
        const noteRef = dehydrateFact(note).find(f => f.type === Note.Type)!;

        let fired = false;
        const anchorSpec: Specification = {
            given: [{ label: { name: "x", type: noteRef.type }, conditions: [] }],
            matches: [],
            projection: { type: "fact", label: "x" }
        };
        const listener = factManager.addSpecificationListener(anchorSpec, async () => {
            fired = true;
        });

        // Save a fact of a different type only.
        await factManager.save(dehydrateFact(author).map(f => ({ fact: f, signatures: [] })));

        factManager.removeSpecificationListener(listener);
        expect(fired).toBe(false);
    });

    it("does not fire for facts of the right type but a different hash", async () => {
        const { factManager } = makeFactManager();

        const expected = new User("expected-key");
        const expectedRef = dehydrateFact(expected)[0];
        const other = new User("other-key");

        let matched = false;
        const anchorSpec: Specification = {
            given: [{ label: { name: "x", type: expectedRef.type }, conditions: [] }],
            matches: [],
            projection: { type: "fact", label: "x" }
        };
        const listener = factManager.addSpecificationListener(anchorSpec, async (results) => {
            for (const r of results) {
                const ref = (r.tuple as any).x;
                if (ref && ref.type === expectedRef.type && ref.hash === expectedRef.hash) {
                    matched = true;
                }
            }
        });

        await factManager.save(dehydrateFact(other).map(f => ({ fact: f, signatures: [] })));

        factManager.removeSpecificationListener(listener);
        expect(matched).toBe(false);
    });
});
