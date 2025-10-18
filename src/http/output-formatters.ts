import { stringify } from 'csv-stringify';
import { Response } from "express";
import { CsvMetadata } from "./csv-metadata";
import { extractValueByLabel } from "./csv-validator";
import { ResultStream } from "./result-stream";

/**
 * Output read results with streaming support.
 * Handles content negotiation and streams data when possible.
 */
export async function outputReadResultsStreaming(
    result: ResultStream<any>,
    res: Response,
    acceptType: string,
    csvMetadata?: CsvMetadata
): Promise<void> {
    switch (acceptType) {
        case "application/x-ndjson":
            // NDJSON format - stream one JSON object per line
            await streamAsNDJSON(result, res);
            break;
        case "text/csv":
            // CSV format - stream as CSV using csv-stringify
            if (csvMetadata) {
                await streamAsCSVWithStringify(result, res, csvMetadata);
            } else {
                throw new Error("CSV metadata is required for CSV output format");
            }
            break;
        case "application/json":
            // Compact JSON
            await collectAndSendCompactJSON(result, res);
            break;
        case "text/plain":
            // Pretty-printed JSON
            await collectAndSendPrettyJSON(result, res);
            break;
        default:
            // Default to pretty-printed JSON for unrecognized types
            await collectAndSendPrettyJSON(result, res);
            break;
    }
}

/**
 * Stream results as NDJSON (newline-delimited JSON).
 * Each result is written as a separate line.
 */
export async function streamAsNDJSON(stream: ResultStream<any>, res: Response): Promise<void> {
    res.type("application/x-ndjson");

    try {
        let item;
        while ((item = await stream.next()) !== null) {
            res.write(JSON.stringify(item) + '\n');
        }
        res.end();
    } catch (error) {
        // Send error as NDJSON line
        const errorFrame = {
            error: true,
            message: error instanceof Error ? error.message : String(error)
        };
        res.write(JSON.stringify(errorFrame) + '\n');
        res.end();
    } finally {
        await stream.close();
    }
}

/**
 * Collect all results from stream and send as compact JSON.
 * Used for application/json format.
 */
export async function collectAndSendCompactJSON(
    stream: ResultStream<any>,
    res: Response
): Promise<void> {
    try {
        const results: any[] = [];
        let item;
        while ((item = await stream.next()) !== null) {
            results.push(item);
        }

        res.type("application/json");
        res.send(JSON.stringify(results));
    } finally {
        await stream.close();
    }
}

/**
 * Collect all results from stream and send as pretty-printed JSON.
 * Used for text/plain format and as default for unrecognized Accept types.
 */
export async function collectAndSendPrettyJSON(
    stream: ResultStream<any>,
    res: Response
): Promise<void> {
    try {
        const results: any[] = [];
        let item;
        while ((item = await stream.next()) !== null) {
            results.push(item);
        }

        res.type("text/plain");
        res.send(JSON.stringify(results, null, 2));
    } finally {
        await stream.close();
    }
}

/**
 * Stream results as CSV using csv-stringify library.
 * Headers are provided from the specification metadata.
 */
export async function streamAsCSVWithStringify(
    stream: ResultStream<any>,
    res: Response,
    csvMetadata: CsvMetadata
): Promise<void> {
    res.type("text/csv");

    // Helper to await 'finish' or 'error' events on a stream
    function finishedAsync(stream: NodeJS.EventEmitter): Promise<void> {
        return new Promise((resolve, reject) => {
            stream.once('finish', resolve);
            stream.once('error', reject);
        });
    }

    let stringifier: any;
    try {
        // Create csv-stringify stringifier with headers from specification
        stringifier = stringify({
            header: true,
            columns: csvMetadata.headers,
            cast: {
                // Custom casting for special types
                boolean: (value) => value ? 'true' : 'false',
                date: (value) => {
                    if (value instanceof Date) {
                        return value.toISOString();
                    }
                    return String(value);
                },
                object: (value) => {
                    // Handle nested objects
                    if (value && typeof value === 'object') {
                        // Fact reference - just use hash
                        if (value.type && value.hash) {
                            return value.hash;
                        }
                        // Other objects - stringify
                        return JSON.stringify(value);
                    }
                    return String(value);
                }
            }
        });

        // Pipe stringifier to response
        stringifier.pipe(res);

        // Stream data through stringifier
        let item: any = null;
        while ((item = await stream.next()) !== null) {
            // Extract values in header order
            const row: any = {};
            for (const header of csvMetadata.headers) {
                const value = extractValueByLabel(item, header);
                row[header] = value !== null && value !== undefined ? value : '';
            }
            
            // Write row to stringifier
            stringifier.write(row);
        }

        // Signal end of data
        stringifier.end();

        // Await finish or error
        await finishedAsync(stringifier);

    } catch (error) {
        console.error('Error in CSV streaming:', error);
        if (!res.headersSent) {
            res.status(500).send('Error generating CSV');
        }
        throw error;
    } finally {
        await stream.close();
    }
}
