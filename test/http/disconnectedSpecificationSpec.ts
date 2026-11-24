import express from "express";
import { Server } from "http";
import { AddressInfo } from "net";

import {
    FactManager,
    FactReference,
    FeedCache,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    ProjectedResult,
    ReferencesByName,
    Specification
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter } from "../../src/http/router";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// Issue #250. The router parses a request's specification with jinaga's
// SpecificationParser and then hands it to the SQL builders. Nothing in
// between refused a specification whose labels fall into more than one
// connected component, so one reached the builders — which answered it with
// the product of its components once #233's CROSS JOIN landed, and threw
// "Neither predecessor nor successor fact has been written" before that. Both
// are wrong answers to a request that has no meaning.
//
// jinaga/jinaga.js#436, released in jinaga 6.17.0, moves the refusal into the
// parser and raises it as an `Invalid`, which the router's existing handleError
// already renders as 400. The server adds no connectedness check of its own:
// these tests hold the guarantee that the library refuses such a request
// before any SQL is generated, so the builders can go on relying on never
// receiving one.

// The shape of the specification issue #250 demonstrates: two givens, each
// with its own successor chain, and nothing joining the two chains. Written
// over this test's own fact types.
const DISCONNECTED_SPECIFICATION = `
    (o1: Disconnected.Office, o2: Disconnected.Office) {
        e1: Disconnected.Employee [
            e1->office: Disconnected.Office = o1
        ]
        e2: Disconnected.Employee [
            e2->office: Disconnected.Office = o2
        ]
    } => {
        a = e1
        b = e2
    }
`;

// The same two chains, joined by one path condition: e2 succeeds e1. This is
// the control. It shares the givens, the fact types, the projection and the
// declaration with the specification above, so a 400 on that one and a 200
// here can only be the connectedness of the matches.
const CONNECTED_SPECIFICATION = `
    (o1: Disconnected.Office, o2: Disconnected.Office) {
        e1: Disconnected.Employee [
            e1->office: Disconnected.Office = o1
        ]
        e2: Disconnected.Employee [
            e2->office: Disconnected.Office = o2
            e2->manager: Disconnected.Employee = e1
        ]
    } => {
        a = e1
        b = e2
    }
`;

// jinaga/jinaga.js#437, in the same jinaga 6.17.0, extends the refusal to each
// scope of a projection. A child specification inherits its parent's matches,
// so a child whose own matches reach a given the parent never reached, and
// which joins nothing of its parent's, is the product of two chains inside
// that child. This is specification P of issue #233, over this test's types:
// the child `others` inherits e1 and o1 and adds e2, reaching only o2. Issue
// #251 takes the release that refuses it.
const CHILD_NOT_JOINED_TO_PARENT = `
    (o1: Disconnected.Office, o2: Disconnected.Office) {
        e1: Disconnected.Employee [
            e1->office: Disconnected.Office = o1
        ]
    } => {
        others = {
            e2: Disconnected.Employee [
                e2->office: Disconnected.Office = o2
            ]
        } => {
            pairings = {
                p: Disconnected.Pairing [
                    p->lead: Disconnected.Employee = e1
                    p->report: Disconnected.Employee = e2
                ]
            } => p
        }
    }
`;

// The same child, joined to its parent by one path condition, and still
// reaching o2, which its parent never reached. The control for the pair above:
// it differs from it only in that one condition, and it is the shape issue
// #251 puts in P's place, so a child projection that reaches a second given is
// shown to be servable rather than refused along with it.
const CHILD_JOINED_TO_PARENT = `
    (o1: Disconnected.Office, o2: Disconnected.Office) {
        e1: Disconnected.Employee [
            e1->office: Disconnected.Office = o1
        ]
    } => {
        others = {
            e2: Disconnected.Employee [
                e2->manager: Disconnected.Employee = e1
                e2->office: Disconnected.Office = o2
            ]
        } => e2
    }
`;

// Both routes take the specification after a declaration that supplies its
// start facts. The declaration is identical for both specifications.
const DECLARATION = `
    let o1: Disconnected.Office = { identifier: "office-1" }
    let o2: Disconnected.Office = { identifier: "office-2" }
`;

function requestBody(specification: string): string {
    return `${DECLARATION}\n${specification}`;
}

// Records every read and feed the router asks of storage. A specification the
// parser refuses never reaches these, which is the guarantee the SQL builders
// rely on; recording the calls rather than asserting on generated SQL keeps
// the check at the boundary the router controls.
class RecordingStore extends MemoryStore {
    public readSpecifications: Specification[] = [];
    public feedSpecifications: Specification[] = [];

    read(start: FactReference[], specification: Specification): Promise<ProjectedResult[]> {
        this.readSpecifications.push(specification);
        return super.read(start, specification);
    }

    feed(feed: Specification, start: FactReference[], bookmark: string) {
        this.feedSpecifications.push(feed);
        return super.feed(feed, start, bookmark);
    }
}

// POST /feeds answers with the hashes of the feeds it registered, so a
// specification it accepted leaves feeds here. One it refused leaves none.
class RecordingFeedCache extends FeedCache {
    public registered: Specification[] = [];

    addFeeds(feeds: Specification[], namedStart: ReferencesByName): string[] {
        this.registered.push(...feeds);
        return super.addFeeds(feeds, namedStart);
    }
}

describe("a disconnected specification on /read and POST /feeds", () => {
    let server: Server;
    let baseUrl: string;
    let store: RecordingStore;
    let feedCache: RecordingFeedCache;

    beforeEach(async () => {
        store = new RecordingStore();
        feedCache = new RecordingFeedCache();
        const keystore = new MemoryKeystore();
        const factManager = new FactManager(
            new PassThroughFork(store), new ObservableSource(store), store, new NetworkNoOp(), []);
        // No authorization or distribution rules: neither route consults them
        // before parsing, and leaving them out keeps a refusal here from being
        // confusable with a 403.
        const authorization = new AuthorizationKeystore(factManager, store, keystore, null, null);
        const router = new HttpRouter(factManager, authorization, feedCache, "*");

        const app = express();
        app.use(express.text());
        app.use(router.handler);
        server = app.listen(0);
        await new Promise<void>(resolve => server.once("listening", () => resolve()));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    function post(path: string, specification: string) {
        return fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: requestBody(specification)
        });
    }

    // Criterion 1.
    it("answers 400 on /read and names both subgraphs", async () => {
        const response = await post("/read", DISCONNECTED_SPECIFICATION);
        const body = await response.text();

        expect(response.status).toBe(400);
        // The two components the library found, each naming its labels and
        // their types. Asserting on both is what distinguishes this refusal
        // from any other 400 the route can produce.
        expect(body).toContain("'e1:Disconnected.Employee', 'o1:Disconnected.Office'");
        expect(body).toContain("'e2:Disconnected.Employee', 'o2:Disconnected.Office'");
    });

    // Criterion 1: and issues no SQL.
    it("reads nothing from storage for a disconnected /read", async () => {
        await post("/read", DISCONNECTED_SPECIFICATION);

        expect(store.readSpecifications).toEqual([]);
        expect(store.feedSpecifications).toEqual([]);
    });

    // Criterion 2.
    it("answers 400 on POST /feeds and names both subgraphs", async () => {
        const response = await post("/feeds", DISCONNECTED_SPECIFICATION);
        const body = await response.text();

        expect(response.status).toBe(400);
        expect(body).toContain("'e1:Disconnected.Employee', 'o1:Disconnected.Office'");
        expect(body).toContain("'e2:Disconnected.Employee', 'o2:Disconnected.Office'");
    });

    it("registers no feed for a disconnected POST /feeds", async () => {
        await post("/feeds", DISCONNECTED_SPECIFICATION);

        expect(feedCache.registered).toEqual([]);
        expect(store.readSpecifications).toEqual([]);
        expect(store.feedSpecifications).toEqual([]);
    });

    // The refusal is an Invalid, so it reports as a client error rather than
    // as the 500 the builders' own throw produced before the upgrade.
    it("does not report the refusal as a server error", async () => {
        const read = await post("/read", DISCONNECTED_SPECIFICATION);
        const feeds = await post("/feeds", DISCONNECTED_SPECIFICATION);

        expect(read.status).not.toBe(500);
        expect(feeds.status).not.toBe(500);
    });

    // The control. Connectedness is what the two specifications differ in, so
    // this is what keeps the tests above from passing for a route that refuses
    // every specification it is sent.
    describe("the same two chains, joined", () => {
        it("answers /read and reaches storage", async () => {
            const response = await post("/read", CONNECTED_SPECIFICATION);

            expect(response.status).toBe(200);
            expect(store.readSpecifications).toHaveLength(1);
        });

        it("registers a feed on POST /feeds", async () => {
            const response = await post("/feeds", CONNECTED_SPECIFICATION);

            expect(response.status).toBe(200);
            expect(feedCache.registered.length).toBeGreaterThan(0);
        });
    });

    // Issue #251, criterion 1. The per-scope rule refuses a shape whose top
    // level is connected, so the subgraphs it names are the same two this
    // file's other refusal names. What tells the two rules apart is the scope
    // the message attributes the product to, which is asserted here.
    describe("a child specification that is not joined to its parent", () => {
        const CHILD_SCOPE_REFUSAL =
            "a child specification of the projection would be the product of 2 chains";

        it("answers 400 on /read, naming the child scope", async () => {
            const response = await post("/read", CHILD_NOT_JOINED_TO_PARENT);
            const body = await response.text();

            expect(response.status).toBe(400);
            expect(body).toContain(CHILD_SCOPE_REFUSAL);
            expect(body).toContain("'e1:Disconnected.Employee', 'o1:Disconnected.Office'");
            expect(body).toContain("'e2:Disconnected.Employee', 'o2:Disconnected.Office'");
        });

        it("reads nothing from storage for such a /read", async () => {
            await post("/read", CHILD_NOT_JOINED_TO_PARENT);

            expect(store.readSpecifications).toEqual([]);
            expect(store.feedSpecifications).toEqual([]);
        });

        it("answers 400 on POST /feeds, naming the child scope", async () => {
            const response = await post("/feeds", CHILD_NOT_JOINED_TO_PARENT);
            const body = await response.text();

            expect(response.status).toBe(400);
            expect(body).toContain(CHILD_SCOPE_REFUSAL);
        });

        it("registers no feed for such a POST /feeds", async () => {
            await post("/feeds", CHILD_NOT_JOINED_TO_PARENT);

            expect(feedCache.registered).toEqual([]);
            expect(store.readSpecifications).toEqual([]);
            expect(store.feedSpecifications).toEqual([]);
        });

        // The control.
        describe("the same child, joined to its parent", () => {
            it("answers /read and reaches storage", async () => {
                const response = await post("/read", CHILD_JOINED_TO_PARENT);

                expect(response.status).toBe(200);
                expect(store.readSpecifications).toHaveLength(1);
            });

            it("registers a feed on POST /feeds", async () => {
                const response = await post("/feeds", CHILD_JOINED_TO_PARENT);

                expect(response.status).toBe(200);
                expect(feedCache.registered.length).toBeGreaterThan(0);
            });
        });
    });
});
