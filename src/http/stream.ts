// This class logs nothing on its success path. A stream's lifetime is reported
// once by the request that opened it (see getOrStream in router.ts), and a line
// per feed, per replayed item, or per done handler says the same thing again
// once per unit of traffic. Issue #192: those per-item lines were 11.9% of a
// 2.8-million-line production log. Failures still log, because a failed handler
// is an event an operator cannot reconstruct from the summary.
export class Stream<T> {
    private queue: T[] = [];
    private handlers: ((data: T) => void)[] = [];
    private doneHandlers: (() => void)[] = [];
    private closed = false;
    private readonly streamId: string;

    constructor() {
        this.streamId = Math.random().toString(36).substring(2, 10);
    }

    next(handler: (data: T) => void): Stream<T> {
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to add handler to closed stream`);
            return this;
        }

        this.handlers.push(handler);

        // Replay queued data to new handler
        this.queue.forEach((data, index) => {
            try {
                handler(data);
            } catch (error) {
                console.error(`[Stream:${this.streamId}] Error replaying queued item ${index + 1}: ${error}`);
            }
        });

        return this;
    }

    done(handler: () => void): Stream<T> {
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to add done handler to closed stream - executing immediately`);
            try {
                handler();
            } catch (error) {
                console.error(`[Stream:${this.streamId}] Error in immediate done handler: ${error}`);
            }
            return this;
        }

        this.doneHandlers.push(handler);
        return this;
    }

    close(): void {
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to close already closed stream`);
            return;
        }

        this.closed = true;

        // Execute done handlers
        this.doneHandlers.forEach((handler, index) => {
            try {
                handler();
            } catch (error) {
                console.error(`[Stream:${this.streamId}] Error in done handler ${index + 1}: ${error}`);
            }
        });

        // Clear all references
        this.queue = [];
        this.handlers = [];
        this.doneHandlers = [];
    }

    feed(data: any): void {
        const feedStart = Date.now();

        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to feed data to closed stream - Data type: ${typeof data}`);
            return;
        }

        const handlerCount = this.handlers.length;

        this.queue.push(data);

        // Notify all handlers
        this.handlers.forEach((handler, index) => {
            try {
                const handlerStart = Date.now();
                handler(data);
                const handlerDuration = Date.now() - handlerStart;

                if (handlerDuration > 50) {
                    console.warn(`[Stream:${this.streamId}] SLOW handler - Handler ${index + 1}/${handlerCount}, Duration: ${handlerDuration}ms`);
                }
            } catch (error) {
                console.error(`[Stream:${this.streamId}] ERROR in handler ${index + 1}/${handlerCount}: ${error}`);
            }
        });

        const totalDuration = Date.now() - feedStart;

        if (totalDuration > 100) {
            console.warn(`[Stream:${this.streamId}] SLOW feed operation - Duration: ${totalDuration}ms`);
        }
    }
}
