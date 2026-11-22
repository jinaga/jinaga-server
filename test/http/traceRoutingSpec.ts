import express from "express";
import { Server } from "http";
import { AddressInfo } from "net";

import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    FactManager,
    FeedCache,
    FeedResponse,
    MemoryStore,
    NetworkNoOp,
    NoOpTracer,
    ObservableSource,
    PassThroughFork,
    Trace,
    Tracer,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter, RequestUser } from "../../src/http/router";
import { Stream } from "../../src/http/stream";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// Issue #189. Two server-owned defects made #187's feed stampede impossible to
// reconstruct: the streaming feed query ran on every wake of every session and
// emitted no dependency at all, and the lines router.ts and stream.ts did write
// went straight to `console`, bypassing whatever tracer the host installed.
//
// These tests assert on what the tracer receives, which is the behavior. They
// deliberately do not scan the source for `console.`: such a test could fail
// only when the text it searches changes, and would pass a call that reached
// the console by some other spelling.

class Post {
    public static Type = "trace.Post" as const;
    public type = Post.Type;
    constructor(public author: User, public body: string) { }
}

const model = buildModel(b => b
    .type(User)
    .type(Post, m => m.predecessor("author", User))
);

const userIdentity = { provider: "mock", id: "subscriber" };

// Records everything `Trace` forwards, so a test can say which level a line
// arrived at and which dependencies a request opened. `dependency` still runs
// its operation, so the code under test behaves as it does in production.
class CapturingTracer extends NoOpTracer implements Tracer {
    readonly lines: { level: string; message: string }[] = [];
    readonly dependencies: { name: string; data: string }[] = [];

    debug(message: string): void {
        this.lines.push({ level: "debug", message });
    }

    info(message: string): void {
        this.lines.push({ level: "info", message });
    }

    warn(message: string): void {
        this.lines.push({ level: "warn", message });
    }

    error(error: any): void {
        this.lines.push({ level: "error", message: String(error) });
    }

    dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
        this.dependencies.push({ name, data });
        return operation();
    }

    namesOf(name: string): { name: string; data: string }[] {
        return this.dependencies.filter(d => d.name === name);
    }
}

async function withTracer<T>(tracer: Tracer, action: () => Promise<T>): Promise<T> {
    Trace.configure(tracer);
    try {
        return await action();
    } finally {
        Trace.configure(new NoOpTracer());
    }
}

// Every console method a line could escape through, so a line that reaches the
// console under a different name than the one it used to carry is still caught.
const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;

class ConsoleSpy {
    private readonly spies: jest.SpyInstance[] = [];
    readonly calls: string[] = [];

    constructor() {
        for (const method of CONSOLE_METHODS) {
            this.spies.push(jest.spyOn(console, method).mockImplementation((...args: any[]) => {
                this.calls.push(args.map(a => String(a)).join(" "));
            }));
        }
    }

    restore(): void {
        for (const spy of this.spies) {
            spy.mockRestore();
        }
    }
}

interface Harness {
    router: HttpRouter;
    factManager: FactManager;
    requestUser: RequestUser;
    authorRef: { type: string; hash: string };
}

async function makeHarness(): Promise<Harness> {
    const storage = new MemoryStore();
    const keystore = new MemoryKeystore();
    const userFact = await keystore.getOrCreateUserFact(userIdentity);
    const author = new User(userFact.fields.publicKey);
    const authorRef = dehydrateFact(author)[0];

    const factManager = new FactManager(
        new PassThroughFork(storage), new ObservableSource(storage), storage, new NetworkNoOp(), []);

    const authorizationRules = new AuthorizationRules(model)
        .any(User)
        .any(Post);
    const authorization = new AuthorizationKeystore(
        factManager, storage, keystore, authorizationRules, null);

    const router = new HttpRouter(factManager, authorization, new FeedCache(), "*");

    return {
        router,
        factManager,
        requestUser: { provider: userIdentity.provider, id: userIdentity.id, profile: {} as any },
        authorRef
    };
}

async function waitForMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

// Registers a feed for posts by the author and returns its hash, the way a
// client subscribes before it polls or streams.
async function registerFeed(h: Harness): Promise<string> {
    const input =
        `let p: Jinaga.User = #${h.authorRef.hash}\n` +
        `(p: Jinaga.User) {\n` +
        `    post: ${Post.Type} [\n` +
        `        post->author: Jinaga.User = p\n` +
        `    ]\n` +
        `} => post`;

    const feedsResponse = await (h.router as any).feeds(h.requestUser, input);
    expect(feedsResponse.feeds.length).toBeGreaterThan(0);
    return feedsResponse.feeds[0];
}

describe("feed query tracing", () => {
    // Issue #189 criterion 1.
    it("records one feedStream dependency carrying the feed hash for a streaming cycle", async () => {
        const h = await makeHarness();
        const feedHash = await registerFeed(h);
        const tracer = new CapturingTracer();

        const stream: Stream<FeedResponse> = await withTracer(tracer, async () => {
            const stream: Stream<FeedResponse> = await (h.router as any).streamFeed(
                h.requestUser, { hash: feedHash }, {});
            expect(stream).not.toBeNull();
            stream.next(() => { });
            // The store holds no post, so the session's first cycle issues one
            // query, finds no tuples, emits SYNC and stops.
            await waitForMicrotasks();
            return stream;
        });
        stream.close();

        expect(tracer.namesOf("feedStream")).toEqual([{ name: "feedStream", data: feedHash }]);
        // The wrapper sits at the call site rather than inside queryFeed, so a
        // streaming query is not also reported as a poll.
        expect(tracer.namesOf("feed")).toEqual([]);
    });

    // Issue #189 criterion 2. The polling handler wraps its own call, so
    // wrapping queryFeed itself would report each poll twice.
    it("records one feed dependency and no feedStream dependency for a poll", async () => {
        const h = await makeHarness();
        const feedHash = await registerFeed(h);
        const tracer = new CapturingTracer();

        const response: FeedResponse = await withTracer(tracer, () =>
            (h.router as any).feed(h.requestUser, { hash: feedHash }, {}));

        expect(response).not.toBeNull();
        expect(tracer.namesOf("feed")).toEqual([{ name: "feed", data: feedHash }]);
        expect(tracer.namesOf("feedStream")).toEqual([]);
    });
});

describe("stream logging through Trace", () => {
    // One test issues a streaming request, so every server it starts is
    // closed; an untracked one keeps the process alive after the suite ends.
    const servers: Server[] = [];

    // Only streamFeed is stubbed, so the test controls the stream the handler
    // attaches to without standing up a feed cache and a listener.
    async function listen(stream: Stream<FeedResponse>) {
        const storage = new MemoryStore();
        const factManager = new FactManager(
            new PassThroughFork(storage), new ObservableSource(storage), storage, new NetworkNoOp(), []);
        const authorization = new AuthorizationKeystore(
            factManager, storage, new MemoryKeystore(),
            new AuthorizationRules(buildModel(b => b.type(User))), null);
        const router = new HttpRouter(factManager, authorization, new FeedCache(), "*");
        (router as any).streamFeed = () => Promise.resolve(stream);

        const app = express();
        app.use(router.handler);
        const server = app.listen(0);
        servers.push(server);
        await new Promise<void>(resolve => server.once("listening", () => resolve()));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    afterEach(async () => {
        const closing = servers.splice(0, servers.length);
        for (const server of closing) {
            // A streaming response leaves its socket open, so close() alone
            // would wait for a connection the test has finished with.
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    async function waitFor(condition: () => boolean) {
        for (let attempt = 0; attempt < 500 && !condition(); attempt++) {
            await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        expect(condition()).toBe(true);
    }

    // Issue #189 criterion 3.
    it("reports opening, ending and feeding a closed stream through the tracer and not the console", async () => {
        const stream = new Stream<FeedResponse>();
        const baseUrl = await listen(stream);
        const tracer = new CapturingTracer();

        const consoleSpy = new ConsoleSpy();
        try {
            await withTracer(tracer, async () => {
                // Resolves once the handler has flushed headers, which it does
                // after writing the line that reports the stream open.
                const response = await fetch(`${baseUrl}/feeds/feed-hash`, {
                    headers: { "Accept": "application/x-jinaga-feed-stream" }
                });
                // The handler ends the socket rather than the chunked
                // response. Reading the body only releases the connection.
                const drained = response.text().catch(() => undefined);

                await waitFor(() => tracer.lines.length >= 1);
                stream.close();
                await waitFor(() => tracer.lines.length >= 2);

                // The request's done handler has run, so the stream is closed
                // on both sides. Feeding it now is the warn case.
                stream.feed({ references: [], bookmark: "late" });
                await drained;
            });
        } finally {
            consoleSpy.restore();
        }

        expect(tracer.lines.map(l => l.level)).toEqual(["info", "info", "warn"]);
        expect(consoleSpy.calls).toEqual([]);
    });
});
