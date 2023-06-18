import { FeedCache, FeedDefinition } from "../http/feed-cache";

export class MemoryFeedCache implements FeedCache {
    private feedDefinitions: { [feedHash: string]: FeedDefinition } = {};

    storeFeed(feedHash: string, feedDefinition: FeedDefinition): Promise<void> {
        this.feedDefinitions[feedHash] = feedDefinition;
        return Promise.resolve();
    }

    getFeed(feedHash: string): Promise<FeedDefinition | undefined> {
        return Promise.resolve(this.feedDefinitions[feedHash]);
    }
}