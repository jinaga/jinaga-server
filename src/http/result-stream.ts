/**
 * ResultStream interface for streaming query results incrementally.
 * This abstraction allows for memory-efficient processing of large result sets.
 */
export interface ResultStream<T> {
    /**
     * Get the next item in the stream.
     * @returns Promise resolving to the next item, or null if stream is exhausted
     */
    next(): Promise<T | null>;
    
    /**
     * Close the stream and release resources.
     */
    close(): Promise<void>;
}

/**
 * Implements ResultStream for AsyncIterable sources.
 * Useful for streaming data from database cursors or other async sources.
 */
export class AsyncIterableResultStream<T> implements ResultStream<T> {
    private iterator: AsyncIterator<T>;
    private closed: boolean = false;

    constructor(iterable: AsyncIterable<T>) {
        this.iterator = iterable[Symbol.asyncIterator]();
    }

    async next(): Promise<T | null> {
        if (this.closed) {
            return null;
        }

        const result = await this.iterator.next();
        if (result.done) {
            await this.close();
            return null;
        }

        return result.value;
    }

    async close(): Promise<void> {
        if (!this.closed) {
            this.closed = true;
            if (this.iterator.return) {
                await this.iterator.return();
            }
        }
    }
}

/**
 * Converts an array to a ResultStream.
 * Useful for backward compatibility and testing.
 */
export async function* arrayAsyncIterable<T>(array: T[]): AsyncIterable<T> {
    for (const item of array) {
        yield item;
    }
}

/**
 * Helper function to convert an array to a ResultStream.
 */
export function arrayToResultStream<T>(array: T[]): ResultStream<T> {
    return new AsyncIterableResultStream(arrayAsyncIterable(array));
}
