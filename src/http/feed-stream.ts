import { FeedResponse } from "jinaga";
import { Stream } from "./stream";

export class FeedStream implements Stream<FeedResponse> {
    private queue: FeedResponse[] = [];
    private handlers: ((data: FeedResponse) => void)[] = [];
    private doneHandlers: (() => void)[] = [];
    private closed = false;

    next(handler: (data: FeedResponse) => void): FeedStream {
        this.handlers.push(handler);
        this.queue.forEach(data => handler(data));
        return this;
    }

    done(handler: () => void): FeedStream {
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