export class Stream<T> {
    private queue: T[] = [];
    private handlers: ((data: T) => void)[] = [];
    private doneHandlers: (() => void)[] = [];
    private closed = false;
    private readonly streamId: string;
    private feedCount = 0;

    constructor() {
        this.streamId = Math.random().toString(36).substring(2, 10);
        console.log(`[Stream:${this.streamId}] Created new stream`);
    }

    next(handler: (data: T) => void): Stream<T> {
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to add handler to closed stream`);
            return this;
        }
        
        this.handlers.push(handler);
        const queueLength = this.queue.length;
        console.log(`[Stream:${this.streamId}] Added handler - Total handlers: ${this.handlers.length}, Queued items: ${queueLength}`);
        
        // Replay queued data to new handler
        this.queue.forEach((data, index) => {
            try {
                handler(data);
                console.log(`[Stream:${this.streamId}] Replayed queued item ${index + 1}/${queueLength} to new handler`);
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
        console.log(`[Stream:${this.streamId}] Added done handler - Total done handlers: ${this.doneHandlers.length}`);
        return this;
    }

    close(): void {
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to close already closed stream`);
            return;
        }
        
        console.log(`[Stream:${this.streamId}] CLOSING stream - Handlers: ${this.handlers.length}, Done handlers: ${this.doneHandlers.length}, Queue: ${this.queue.length}, Feed count: ${this.feedCount}`);
        
        this.closed = true;
        
        // Execute done handlers
        const doneHandlerCount = this.doneHandlers.length;
        this.doneHandlers.forEach((handler, index) => {
            try {
                handler();
                console.log(`[Stream:${this.streamId}] Executed done handler ${index + 1}/${doneHandlerCount}`);
            } catch (error) {
                console.error(`[Stream:${this.streamId}] Error in done handler ${index + 1}: ${error}`);
            }
        });
        
        // Clear all references
        this.queue = [];
        this.handlers = [];
        this.doneHandlers = [];
        
        console.log(`[Stream:${this.streamId}] Stream closed and cleaned up`);
    }

    feed(data: any): void {
        const feedStart = Date.now();
        
        if (this.closed) {
            console.warn(`[Stream:${this.streamId}] Attempted to feed data to closed stream - Data type: ${typeof data}`);
            return;
        }
        
        this.feedCount++;
        const handlerCount = this.handlers.length;
        
        console.log(`[Stream:${this.streamId}] FEEDING data - Feed #${this.feedCount}, Handlers: ${handlerCount}, Queue size before: ${this.queue.length}`);
        
        this.queue.push(data);
        
        // Notify all handlers
        let successCount = 0;
        let errorCount = 0;
        
        this.handlers.forEach((handler, index) => {
            try {
                const handlerStart = Date.now();
                handler(data);
                const handlerDuration = Date.now() - handlerStart;
                successCount++;
                
                if (handlerDuration > 50) {
                    console.warn(`[Stream:${this.streamId}] SLOW handler - Handler ${index + 1}/${handlerCount}, Duration: ${handlerDuration}ms`);
                }
            } catch (error) {
                errorCount++;
                console.error(`[Stream:${this.streamId}] ERROR in handler ${index + 1}/${handlerCount}: ${error}`);
            }
        });
        
        const totalDuration = Date.now() - feedStart;
        console.log(`[Stream:${this.streamId}] Feed complete - Success: ${successCount}, Errors: ${errorCount}, Queue size after: ${this.queue.length}, Duration: ${totalDuration}ms`);
        
        if (totalDuration > 100) {
            console.warn(`[Stream:${this.streamId}] SLOW feed operation - Duration: ${totalDuration}ms`);
        }
    }
}