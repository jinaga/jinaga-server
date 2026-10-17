import express from "express";
import { Server } from "http";
import { AddressInfo } from "net";

import {
    AuthorizationRules,
    buildModel,
    DistributionRules,
    FactManager,
    FeedCache,
    FeedResponse,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { HttpRouter } from "../../src/http/router";
import { Stream } from "../../src/http/stream";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

// Issue #192. A streaming response used to describe itself step by step: one
// line per message written, one per queued item replayed, one per done handler
// executed, one before and one after every feed. The line count therefore grew
// with traffic rather than with the number of events worth knowing about, and a
// 23 GB replicator log filled a production disk.
//
// These tests count lines. They deliberately do not match the text of the lines
// that remain, so the wording stays free to improve; the two that do read a line
// assert only the facts criterion 1 requires the end line to carry.

// Every console method a line could be written through, so a line moved from
// log to info is still counted rather than silently disappearing.
const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;

class ConsoleCapture {
    private readonly spies: jest.SpyInstance[] = [];
    readonly lines: string[] = [];

    constructor() {
        for (const method of CONSOLE_METHODS) {
            this.spies.push(jest.spyOn(console, method).mockImplementation((...args: any[]) => {
                // A single call can carry several lines, and it is lines that
                // cost disk, so split rather than counting calls.
                this.lines.push(...args.map(a => String(a)).join(" ").split("\n"));
            }));
        }
    }

    restore(): void {
        for (const spy of this.spies) {
            spy.mockRestore();
        }
    }
}

function countLines(action: () => void): number {
    const capture = new ConsoleCapture();
    try {
        action();
    } finally {
        capture.restore();
    }
    return capture.lines.length;
}

describe("Stream log volume", () => {
    // Issue #192 Tests, item 1.
    it("writes the same number of lines for one fed item as for a thousand", () => {
        const one = countLines(() => {
            const stream = new Stream<number>();
            stream.next(() => { });
            stream.feed(1);
            stream.close();
        });

        const thousand = countLines(() => {
            const stream = new Stream<number>();
            stream.next(() => { });
            for (let i = 0; i < 1000; i++) {
                stream.feed(i);
            }
            stream.close();
        });

        expect(thousand).toBe(one);
    });

    // Issue #192 Tests, item 2. The handler is added after the data arrives, so
    // the whole queue is replayed to it, and several done handlers are
    // registered: the two remaining per-item loops in stream.ts.
    it("writes no line per queued item or per done handler", () => {
        function run(items: number, doneHandlers: number): number {
            return countLines(() => {
                const stream = new Stream<number>();
                for (let i = 0; i < items; i++) {
                    stream.feed(i);
                }
                for (let i = 0; i < doneHandlers; i++) {
                    stream.done(() => { });
                }
                stream.next(() => { });
                stream.close();
            });
        }

        expect(run(50, 10)).toBe(run(1, 1));
    });

    // Issue #192 criterion 3. The volume comes from the success path, so the
    // failure path keeps its lines: these are the events an operator reading a
    // quiet log is looking for.
    it("still reports a handler that throws", () => {
        const lines = countLines(() => {
            const stream = new Stream<number>();
            stream.next(() => { throw new Error("handler failed"); });
            stream.feed(1);
            stream.close();
        });

        expect(lines).toBeGreaterThan(0);
    });

    it("still reports a done handler that throws", () => {
        const lines = countLines(() => {
            const stream = new Stream<number>();
            stream.done(() => { throw new Error("done handler failed"); });
            stream.close();
        });

        expect(lines).toBeGreaterThan(0);
    });

    it("still reports a feed to a closed stream", () => {
        const lines = countLines(() => {
            const stream = new Stream<number>();
            stream.close();
            stream.feed(1);
        });

        expect(lines).toBeGreaterThan(0);
    });
});

// Criterion 1 is about router.ts and stream.ts together, so these drive the real
// Express handler over a real socket. Only streamFeed and feed are stubbed, so
// that the test controls how many messages the stream delivers without standing
// up a feed cache, a specification and a listener.
describe("streaming request log volume", () => {
    // One test issues two requests, so every server it starts is tracked and
    // closed; an untracked one keeps the process alive after the suite ends.
    const servers: Server[] = [];

    async function listen(messages: FeedResponse | null, stream: Stream<FeedResponse> | null) {
        const store = new MemoryStore();
        const factManager = new FactManager(
            new PassThroughFork(store), new ObservableSource(store), store, new NetworkNoOp(), []);
        const model = buildModel(b => b.type(User));
        const authorization = new AuthorizationKeystore(
            factManager, store, new MemoryKeystore(), new AuthorizationRules(model), new DistributionRules([]));
        const router = new HttpRouter(factManager, authorization, new FeedCache(), "*");
        (router as any).streamFeed = () => Promise.resolve(stream);
        (router as any).feed = () => Promise.resolve(messages);

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

    // Feeds `messages` messages through a live streaming request and returns
    // every line the request wrote, from the moment it was issued to the moment
    // the stream ended.
    async function streamingRequest(messages: number): Promise<string[]> {
        const stream = new Stream<FeedResponse>();
        const baseUrl = await listen(null, stream);

        const capture = new ConsoleCapture();
        try {
            // Resolves once the handler has flushed headers, which it does
            // before attaching the handler that counts messages.
            const response = await fetch(`${baseUrl}/feeds/feed-hash`, {
                headers: { "Accept": "application/x-jinaga-feed-stream" }
            });
            // The handler ends the socket rather than the chunked response, so
            // the client sees the body terminate. Reading it is only here to
            // release the connection.
            const drained = response.text().catch(() => undefined);

            for (let i = 0; i < messages; i++) {
                stream.feed({ references: [], bookmark: `bookmark-${i}` });
            }
            stream.close();

            await waitFor(() => capture.lines.length >= 2);
            const lines = [...capture.lines];
            await drained;
            return lines;
        } finally {
            capture.restore();
        }
    }

    // Issue #192 criterion 1.
    it("writes one line when the stream opens and one when it ends", async () => {
        expect(await streamingRequest(1)).toHaveLength(2);
    });

    it("writes the same number of lines for a thousand messages as for one", async () => {
        const one = await streamingRequest(1);
        const thousand = await streamingRequest(1000);

        expect(thousand).toHaveLength(one.length);
    });

    it("carries the messages sent, the duration and the reason in the end line", async () => {
        const lines = await streamingRequest(3);
        const end = lines[lines.length - 1];

        expect(end).toContain("Messages sent: 3");
        expect(end).toMatch(/Duration: \d+ms/);
        expect(end).toContain("done");
    });

    it("reports a client disconnect as the reason the stream ended", async () => {
        const stream = new Stream<FeedResponse>();
        const baseUrl = await listen(null, stream);

        const capture = new ConsoleCapture();
        try {
            const controller = new AbortController();
            await fetch(`${baseUrl}/feeds/feed-hash`, {
                headers: { "Accept": "application/x-jinaga-feed-stream" },
                signal: controller.signal
            });
            controller.abort();

            await waitFor(() => capture.lines.length >= 2);
            const lines = [...capture.lines];

            expect(lines).toHaveLength(2);
            expect(lines[lines.length - 1]).toContain("disconnect");
        } finally {
            capture.restore();
        }
    });

    // Issue #192 criterion 2.
    it("writes no line for a plain GET", async () => {
        const baseUrl = await listen({ references: [], bookmark: "bookmark" }, null);

        const capture = new ConsoleCapture();
        try {
            const response = await fetch(`${baseUrl}/feeds/feed-hash`);
            await response.text();

            expect(response.status).toBe(200);
            expect(capture.lines).toHaveLength(0);
        } finally {
            capture.restore();
        }
    });
});
