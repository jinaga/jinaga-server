import { EventEmitter } from "events";

import { PayloadTooLarge } from "../../src/http/errors";
import { createLineReader, LineReaderOptions } from "../../src/http/line-reader";

// A stand-in for the request stream, so a body can be delivered in chunks
// split wherever a test needs and the reader's backpressure calls can be
// observed. `deliveredBytes` counts only what a listener actually received:
// once the reader detaches from the stream, later chunks reach nobody, which
// is how the first test below bounds what the reader can be holding.
class FakeStream extends EventEmitter {
    pauseCalls = 0;
    deliveredBytes = 0;
    private paused = false;

    pause(): this {
        this.pauseCalls++;
        this.paused = true;
        return this;
    }

    resume(): this {
        this.paused = false;
        return this;
    }

    isPaused(): boolean {
        return this.paused;
    }

    feed(chunk: Buffer): void {
        if (this.emit("data", chunk)) {
            this.deliveredBytes += chunk.length;
        }
    }

    finish(): void {
        this.emit("end");
    }

    get asReadable(): NodeJS.ReadableStream {
        return this as unknown as NodeJS.ReadableStream;
    }
}

function tick(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

const MiB = 1024 * 1024;

// Deliver a body in the chunks the given interior offsets cut it into, end the
// stream, and drain every line the reader produces.
async function readLinesSplitAt(
    body: Buffer,
    offsets: number[],
    options?: LineReaderOptions
): Promise<string[]> {
    const stream = new FakeStream();
    const readLine = createLineReader(stream.asReadable, options);
    const bounds = [0, ...offsets, body.length];
    for (let i = 1; i < bounds.length; i++) {
        const chunk = body.slice(bounds[i - 1], bounds[i]);
        if (chunk.length > 0) {
            stream.feed(chunk);
        }
    }
    stream.finish();

    const lines: string[] = [];
    let line: string | null;
    while ((line = await readLine()) !== null) {
        lines.push(line);
    }
    return lines;
}

// Issue #169. The save route attaches this reader straight to the request
// stream, so no body-parser limit sits in front of it, and the reader's own
// backpressure counts completed lines waiting in its queue rather than the
// line in progress. A body that never sends a newline therefore grew the
// queue not at all and was buffered whole.
describe("line reader line limit", () => {
    it("rejects the pending read once the line in progress passes the limit", async () => {
        const stream = new FakeStream();
        const readLine = createLineReader(stream.asReadable, { maxLineBytes: 1 * MiB });
        const pending = readLine();
        let settled = false;
        pending.catch(() => { }).then(() => { settled = true; });

        // The Demonstrated input from the issue: 40 chunks of 256 KB with no
        // newline anywhere, which is 10 MB against a 1 MiB limit.
        const chunk = Buffer.alloc(256 * 1024, 0x41);
        for (let i = 0; i < 40; i++) {
            stream.feed(chunk);
        }
        await tick();

        expect(settled).toBe(true);
        await expect(pending).rejects.toBeInstanceOf(PayloadTooLarge);
        // The message carries the limit that was passed, which is what the 413
        // body tells the client.
        await expect(pending).rejects.toThrow(String(1 * MiB));

        // The reader stopped reading rather than going quiet: it paused the
        // stream and detached, so nothing after the refusal reaches it.
        expect(stream.pauseCalls).toBeGreaterThan(0);
        expect(stream.listenerCount("data")).toBe(0);
        // Nothing beyond the limit plus the chunk that crossed it was ever
        // handed to the reader, so that is the most it can have held.
        expect(stream.deliveredBytes).toBeLessThanOrEqual(1 * MiB + chunk.length);
    });

    it("accepts a line of exactly the limit and refuses the byte after it", async () => {
        const atLimit = await readLinesSplitAt(
            Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.from("\n")]),
            [],
            { maxLineBytes: 1024 });
        expect(atLimit).toEqual(["A".repeat(1024)]);

        const stream = new FakeStream();
        const readLine = createLineReader(stream.asReadable, { maxLineBytes: 1024 });
        const pending = readLine();
        pending.catch(() => { });
        stream.feed(Buffer.concat([Buffer.alloc(1025, 0x41), Buffer.from("\n")]));
        await tick();

        await expect(pending).rejects.toBeInstanceOf(PayloadTooLarge);
    });

    it("delivers the lines completed before an oversized one, then refuses", async () => {
        const stream = new FakeStream();
        const readLine = createLineReader(stream.asReadable, { maxLineBytes: 1024 });

        stream.feed(Buffer.from("a short line\n"));
        await expect(readLine()).resolves.toBe("a short line");

        const second = readLine();
        second.catch(() => { });
        stream.feed(Buffer.alloc(2048, 0x41));
        await tick();

        await expect(second).rejects.toBeInstanceOf(PayloadTooLarge);
    });
});

// Criterion 2. The reader is fed by a socket, so a line arrives cut at
// offsets nothing in the protocol chooses. Deferring the join to the newline
// must not change where lines fall or how their bytes decode.
describe("line reader chunk boundaries", () => {
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    // Two multi-byte characters, one 2-byte and one 4-byte, so a cut can land
    // inside a character of either width.
    const text = "héllo\nwörld \u{1F600}\ntail with no newline";
    const body = Buffer.concat([bom, Buffer.from(text, "utf8")]);
    const expected = text.split("\n");

    it("yields the same lines wherever the body is cut", async () => {
        expect(await readLinesSplitAt(body, [])).toEqual(expected);

        // Every interior offset, which necessarily includes the offsets inside
        // each multi-byte character, the offsets inside the BOM, and the two
        // offsets immediately before a newline.
        for (let offset = 1; offset < body.length; offset++) {
            expect(await readLinesSplitAt(body, [offset])).toEqual(expected);
        }

        // One byte at a time, so every cut is taken at once.
        const everyOffset = Array.from({ length: body.length - 1 }, (_, i) => i + 1);
        expect(await readLinesSplitAt(body, everyOffset)).toEqual(expected);
    });

    it("yields the same lines when cut inside a multi-byte character", async () => {
        // Locate the 4-byte character and cut it after its first byte, derived
        // from the body rather than written as a constant.
        const emoji = Buffer.from("\u{1F600}", "utf8");
        const start = body.indexOf(emoji);
        expect(start).toBeGreaterThan(0);

        expect(await readLinesSplitAt(body, [start + 1])).toEqual(expected);
        expect(await readLinesSplitAt(body, [start + 2, start + 3])).toEqual(expected);
    });

    it("yields the same lines when cut immediately before a newline", async () => {
        const newline = body.indexOf(0x0a);
        expect(newline).toBeGreaterThan(0);

        // The cut before the newline, and the cut that leaves the newline
        // alone at the head of the next chunk.
        expect(await readLinesSplitAt(body, [newline])).toEqual(expected);
        expect(await readLinesSplitAt(body, [newline, newline + 1])).toEqual(expected);
    });

    it("drops a trailing newline rather than reporting an empty last line", async () => {
        const terminated = Buffer.from("one\ntwo\n", "utf8");
        expect(await readLinesSplitAt(terminated, [])).toEqual(["one", "two"]);
    });
});

// A review of this change observed that `number` admits several values that
// silently disable the bound: `NaN` and `Infinity` make every comparison
// false, and `??` does not screen them out because only null and undefined
// fall through to the default. Each case below is driven through the reader
// rather than asserted against the guard's source.
describe("line reader invalid limits", () => {
    it.each([
        ["NaN", NaN],
        ["Infinity", Infinity],
        ["-Infinity", -Infinity],
        ["zero", 0],
        ["a negative", -1],
        ["a fraction", 1.5],
        ["beyond the safe integer range", Number.MAX_SAFE_INTEGER + 2]
    ])("refuses to build a reader whose limit is %s", (_label, maxLineBytes) => {
        const stream = new FakeStream();

        expect(() => createLineReader(stream.asReadable, { maxLineBytes }))
            .toThrow(RangeError);
        // Nothing was read, so a refused limit never governs a body.
        expect(stream.listenerCount("data")).toBe(0);
    });

    it("builds a reader at the largest bound a caller can name", async () => {
        const lines = await readLinesSplitAt(
            Buffer.from("one\ntwo\n", "utf8"),
            [],
            { maxLineBytes: Number.MAX_SAFE_INTEGER });

        expect(lines).toEqual(["one", "two"]);
    });

    it("falls back to the default when the limit is left out entirely", async () => {
        // An explicitly undefined limit takes the same path as no options.
        const lines = await readLinesSplitAt(
            Buffer.from("one\n", "utf8"), [], { maxLineBytes: undefined });

        expect(lines).toEqual(["one"]);
    });
});

// Criterion 4. The reader is exported from the package, so a caller that
// passes no options must behave as it did before the limit existed. The
// default is read back out of the reader's behavior rather than off its
// source, so these fail if the default moves.
describe("line reader default limit", () => {
    const defaultLimit = 16 * MiB;

    async function feedUnterminated(totalBytes: number): Promise<{ pending: Promise<string | null> }> {
        const stream = new FakeStream();
        const readLine = createLineReader(stream.asReadable);
        const pending = readLine();
        pending.catch(() => { });

        const chunk = Buffer.alloc(1 * MiB, 0x41);
        let sent = 0;
        while (sent < totalBytes) {
            const size = Math.min(chunk.length, totalBytes - sent);
            stream.feed(chunk.slice(0, size));
            sent += size;
        }
        stream.feed(Buffer.from("\n"));
        await tick();
        return { pending };
    }

    it("delivers a line just under 16 MiB when given no options", async () => {
        const { pending } = await feedUnterminated(defaultLimit - 1);
        const line = await pending;
        expect(line!.length).toBe(defaultLimit - 1);
    });

    it("refuses a line just over 16 MiB when given no options", async () => {
        const { pending } = await feedUnterminated(defaultLimit + 1);
        await expect(pending).rejects.toBeInstanceOf(PayloadTooLarge);
        await expect(pending).rejects.toThrow(String(defaultLimit));
    });
});
