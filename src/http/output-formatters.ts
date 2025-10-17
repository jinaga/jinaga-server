import { Response } from "express";
import { stringify } from 'csv-stringify';
import { ResultStream, arrayToResultStream } from "./result-stream";
import { CsvMetadata } from "./csv-metadata";
import { extractValueByLabel, formatValueForCsv } from "./csv-validator";

/**
 * Output read results with streaming support.
 * Handles content negotiation and streams data when possible.
 */
export async function outputReadResultsStreaming(
    result: any[] | ResultStream<any>,
    res: Response,
    accepts: (type: string) => string | false,
    csvMetadata?: CsvMetadata
): Promise<void> {
    // Convert array to stream if needed
    const stream = Array.isArray(result) ? arrayToResultStream(result) : result;

    if (accepts("application/x-ndjson")) {
        // NDJSON format - stream one JSON object per line
        await streamAsNDJSON(stream, res);
    }
    else if (accepts("text/csv")) {
        // CSV format - stream as CSV using csv-stringify
        if (csvMetadata) {
            await streamAsCSVWithStringify(stream, res, csvMetadata);
        } else {
            // Fallback to old implementation if no metadata
            await streamAsCSV(stream, res);
        }
    }
    else {
        // For JSON and text/plain, collect all results first
        await collectAndSendJSON(stream, res, accepts);
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
 * Collect all results from stream and send as JSON.
 * Used for application/json and text/plain formats that need complete data.
 */
export async function collectAndSendJSON(
    stream: ResultStream<any>,
    res: Response,
    accepts: (type: string) => string | false
): Promise<void> {
    try {
        const results: any[] = [];
        let item;
        while ((item = await stream.next()) !== null) {
            results.push(item);
        }

        if (accepts("application/json")) {
            // Compact JSON
            res.type("application/json");
            res.send(JSON.stringify(results));
        }
        else {
            // Default: text/plain with pretty-printed JSON
            res.type("text/plain");
            res.send(JSON.stringify(results, null, 2));
        }
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

/**
 * Stream results as CSV (legacy implementation without metadata).
 * Used as fallback when CSV is requested without specification metadata.
 * Headers are extracted from first data row.
 */
export async function streamAsCSV(stream: ResultStream<any>, res: Response): Promise<void> {
    res.type("text/csv");

    try {
        let isFirstRow = true;
        let headers: string[] = [];

        let item: any = null;
        while ((item = await stream.next()) !== null) {
            if (isFirstRow) {
                // Extract headers from first item
                headers = Object.keys(item);
                
                // Write CSV header row
                res.write(headers.map(escapeCSV).join(',') + '\n');
                isFirstRow = false;
            }

            // Write data row
            const values = headers.map(key => {
                const value = item[key];
                if (value === null || value === undefined) {
                    return '';
                }
                if (typeof value === 'object') {
                    return escapeCSV(JSON.stringify(value));
                }
                return escapeCSV(String(value));
            });
            res.write(values.join(',') + '\n');
        }

        if (isFirstRow) {
            // No data, just write empty file
            res.write('');
        }

        res.end();
    } catch (error) {
        // For CSV, we can't send error frames like NDJSON
        // Just end the response
        res.end();
    } finally {
        await stream.close();
    }
}

/**
 * Escape a value for CSV format.
 */
function escapeCSV(value: string): string {
    // If value contains comma, quote, or newline, wrap in quotes and escape quotes
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}
