import { Feed } from "jinaga";
import { FeedCache } from "../http/feed-cache";

export class MemoryFeedCache implements FeedCache {
    private feeds: { [feedHash: string]: Feed } = {};

    storeFeed(feedHash: string, feed: Feed): Promise<void> {
        this.feeds[feedHash] = feed;
        return Promise.resolve();
    }

    getFeed(feedHash: string): Promise<Feed | undefined> {
        return Promise.resolve(this.feeds[feedHash]);
    }
}