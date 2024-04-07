export function createLineReaderUsingEvents(stream: NodeJS.ReadableStream): () => Promise<string | null> {
    // Store the bytes read so far that have not yet been processed.
    let buffer = Buffer.alloc(0);
    let linesRead: string[] = [];
    let error: Error | null = null;
    let done = false;

    stream.on('data', (data: Buffer) => {
        let newline: number;
        // Look for the first newline in the data.
        while ((newline = data.indexOf(10)) >= 0) {
            // Extract the line from the data.
            let line = Buffer.concat([buffer, data.slice(0, newline)]).toString();
            buffer = data.slice(newline + 1);
            if (line.charCodeAt(0) === 0xFEFF) {
                // Remove BOM
                line = line.slice(1);
            }
            linesRead.concat(line);
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
            linesRead.concat(line);
        }
        done = true;
    });

    stream.on('error', (e: Error) => {
        error = e;
    });

    const generator = async function*() {
        while (true) {
            if (error) {
                throw error;
            } else if (linesRead.length > 0) {
                yield linesRead.shift()!;
            } else if (done) {
                return;
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    const iterator = generator();
    const readLine = async () => {
        const line = await iterator.next();
        if (line.done) {
            return null;
        }
        return line.value;
    }

    return readLine;
}