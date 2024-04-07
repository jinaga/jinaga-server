const PauseAt = 10;
const ResumeAt = 5;

export function createLineReader(stream: NodeJS.ReadableStream): () => Promise<string | null> {
    // Store the bytes read so far that have not yet been processed.
    let buffer = Buffer.alloc(0);
    // Store a queue of promises that resolve to the next line read.
    let promiseQueue: Promise<string | null>[] = [];
    // Initialize the queue.
    let resolve: (value: string | null) => void;
    let reject: (reason: any) => void;
    promiseQueue.push(new Promise<string | null>((res, rej) => { resolve = res; reject = rej; }));

    stream.on('data', (data: Buffer) => {
        let newline = -1;
        // Look for the first newline in the data.
        while ((newline = data.indexOf(10)) >= 0) {
            // Extract the line from the data.
            let line = Buffer.concat([buffer, data.slice(0, newline)]).toString();
            data = data.slice(newline + 1);
            buffer = Buffer.alloc(0);
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
        // Append the remaining data to the buffer.
        buffer = Buffer.concat([buffer, data]);
    });

    stream.on('end', () => {
        // Extract the last line from the buffer.
        let line = buffer.toString();
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
        reject(e);
    });

    return () => {
        if (promiseQueue.length === 0) {
            throw new Error("Line reader has been closed.");
        }
        const promise = promiseQueue.shift()!;
        if (stream.isPaused() && promiseQueue.length <= ResumeAt) {
            stream.resume();
        }
        return promise;
    };
}