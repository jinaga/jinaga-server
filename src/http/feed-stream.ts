import { FeedResponse } from "jinaga";
import { Stream } from "./stream";

export class FeedStream implements Stream<FeedResponse> {
    private _queue: FeedResponse[] = [];
    private _handlers: ((data: FeedResponse) => void)[] = [];
    private _doneHandlers: (() => void)[] = [];
    private _closed = false;

    next(handler: (data: FeedResponse) => void): FeedStream {
        this._handlers.push(handler);
        this._queue.forEach(data => handler(data));
        return this;
    }

    done(handler: () => void): FeedStream {
        this._doneHandlers.push(handler);
        return this;
    }

    close(): void {
        this._closed = true;
        this.end();
    }

    feed(data: any): void {
        if (this._closed) {
            throw new Error("Cannot feed a closed stream");
        }
        this._queue.push(data);
        this._handlers.forEach(handler => handler(data));
    }

    end(): void {
        this._doneHandlers.forEach(handler => handler());
    }
}