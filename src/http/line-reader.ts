import { PayloadTooLarge } from "./errors";

const PauseAt = 10;
const ResumeAt = 5;

// Bound on one line when the caller names none. The save route reaches this
// reader without passing through Express's body parsers, so before issue #169
// no limit applied to it at all and a body with no newline was buffered whole.
const DefaultMaxLineBytes = 16 * 1024 * 1024;

export interface LineReaderOptions {
    /**
     * Maximum number of bytes in a single line, not counting its newline.
     * A line that would exceed this rejects the pending read with
     * {@link PayloadTooLarge} and the reader stops reading the stream.
     * Defaults to 16 MiB.
     *
     * Must be a positive integer within the safe integer range. Anything
     * else — `NaN`, `Infinity`, zero, a negative, a fraction — denotes no
     * usable bound, and creating the reader throws a `RangeError` rather
     * than reading a body the limit would not govern.
     */
    maxLineBytes?: number;
}

/**
 * Resolve a configured line limit to the number the reader compares against,
 * refusing a value that would denote no usable bound.
 *
 * The type `number` admits several values that silently disable the limit
 * rather than setting it. `NaN` and `Infinity` make every `>` comparison
 * false, so the reader would buffer without end — the very defect the limit
 * exists to prevent, reintroduced by a caller's typo. Zero and negatives
 * refuse every line instead. `??` does not screen any of them out, because
 * only `null` and `undefined` fall through to the default.
 *
 * Throwing is what makes the bound dependable: a limit that cannot hold is a
 * configuration error, and it is better to say so than to serve requests with
 * no protection. A caller that wants the largest bound available passes
 * `Number.MAX_SAFE_INTEGER` and says so explicitly.
 */
export function validateMaxLineBytes(maxLineBytes: number | undefined): number {
    if (maxLineBytes === undefined) {
        return DefaultMaxLineBytes;
    }
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
        throw new RangeError(
            "A line limit must be a positive integer no greater than " +
            `${Number.MAX_SAFE_INTEGER}, so it cannot be ${maxLineBytes}.`);
    }
    return maxLineBytes;
}

export function createLineReader(
    stream: NodeJS.ReadableStream,
    options: LineReaderOptions = {}
): () => Promise<string | null> {
    // Refuse an unusable limit before taking a single byte from the stream.
    const maxLineBytes = validateMaxLineBytes(options.maxLineBytes);
    // The line in progress, as the chunks it arrived in plus their total size.
    // Joining is deferred to the newline so a line delivered in N chunks is
    // copied once rather than N times: concatenating on every chunk made the
    // copying quadratic in the length of the line (issue #169).
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    // Store a queue of promises that resolve to the next line read.
    let promiseQueue: Promise<string | null>[] = [];
    // Initialize the queue.
    let resolve: (value: string | null) => void;
    let reject: (reason: any) => void;
    promiseQueue.push(new Promise<string | null>((res, rej) => { resolve = res; reject = rej; }));
    // Set once the line limit is exceeded. From then on the reader is done: it
    // holds nothing, takes nothing more from the stream, and never resumes it.
    let stopped = false;

    // Backpressure counts completed lines waiting in the queue, so it says
    // nothing about the line in progress. That is the whole of the limit's
    // job: a client that never sends a newline is never paused by the queue,
    // because the queue never grows.
    function exceedLimit() {
        stopped = true;
        // Discard what was buffered before answering, so the error does not
        // travel with a reference to the bytes that provoked it.
        pendingChunks = [];
        pendingBytes = 0;
        stream.pause();
        stream.removeListener('data', onData);
        reject(new PayloadTooLarge(
            `A line of the request body exceeded the maximum of ${maxLineBytes} bytes.`));
    }

    function onData(data: Buffer) {
        if (stopped) {
            return;
        }
        let newline = -1;
        // Look for the first newline in the data.
        while ((newline = data.indexOf(10)) >= 0) {
            const head = data.slice(0, newline);
            if (pendingBytes + head.length > maxLineBytes) {
                exceedLimit();
                return;
            }
            // Extract the line from the data.
            pendingChunks.push(head);
            let line = Buffer.concat(pendingChunks).toString();
            data = data.slice(newline + 1);
            pendingChunks = [];
            pendingBytes = 0;
            if (line.charCodeAt(0) === 0xFEFF) {
                // Remove BOM
                line = line.slice(1);
            }
            // Resolve the promise with the line.
            resolve(line);
            // Create a new promise for the next line.
            promiseQueue.push(new Promise<string | null>((res, rej) => { resolve = res; reject = rej; }));

            // Apply backpressure if the promise queue gets too deep
            if (promiseQueue.length > PauseAt) {
                stream.pause();
            }
        }
        // Hold the remaining data as the line in progress. Check the limit
        // before taking it, so the reader itself never holds more than
        // maxLineBytes.
        if (data.length > 0) {
            if (pendingBytes + data.length > maxLineBytes) {
                exceedLimit();
                return;
            }
            pendingChunks.push(data);
            pendingBytes += data.length;
        }
    }

    stream.on('data', onData);

    stream.on('end', () => {
        if (stopped) {
            return;
        }
        // Extract the last line from the buffer.
        let line = Buffer.concat(pendingChunks).toString();
        pendingChunks = [];
        pendingBytes = 0;
        if (line.charCodeAt(0) === 0xFEFF) {
            // Remove BOM
            line = line.slice(1);
        }
        // If the stream ends with a newline, then don't add an empty line.
        if (line.length > 0) {
            resolve(line);
            promiseQueue.push(new Promise<string | null>((res, rej) => { resolve = res; reject = rej; }));
        }
        resolve(null);
    });

    stream.on('error', (e: Error) => {
        if (stopped) {
            return;
        }
        reject(e);
    });

    return () => {
        if (promiseQueue.length === 0) {
            throw new Error("Line reader has been closed.");
        }
        const promise = promiseQueue.shift()!;
        if (!stopped && stream.isPaused() && promiseQueue.length <= ResumeAt) {
            stream.resume();
        }
        return promise;
    };
}
