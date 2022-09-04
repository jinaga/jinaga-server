import { Feed } from "jinaga";

export interface FeedCache {
    storeFeed(feedHash: string, feed: Feed): Promise<void>;
    getFeed(feedHash: string): Promise<Feed | undefined>;
}