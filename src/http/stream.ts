export class Stream<T> {
    private queue: T[] = [];
    private handlers: ((data: T) => void)[] = [];
    private doneHandlers: (() => void)[] = [];
    private closed = false;

    next(handler: (data: T) => void): Stream<T> {
        this.handlers.push(handler);
        this.queue.forEach(data => handler(data));
        return this;
    }

    done(handler: () => void): Stream<T> {
        this.doneHandlers.push(handler);
        return this;
    }

    close(): void {
        this.closed = true;
        this.doneHandlers.forEach(handler => handler());
        this.queue = [];
        this.handlers = [];
        this.doneHandlers = [];
    }

    feed(data: any): void {
        if (!this.closed) {
            this.queue.push(data);
            this.handlers.forEach(handler => handler(data));
        }
    }
}