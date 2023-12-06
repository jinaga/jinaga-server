import { FactReference, Feed } from "jinaga";

export interface FeedDefinition {
    givenHash: string;
    start: {
        factReference: FactReference,
        index: number
    }[],
    feed: Feed
}

export interface FeedCache {
    storeFeed(feedHash: string, feedDefinition: FeedDefinition): Promise<void>;
    getFeed(feedHash: string): Promise<FeedDefinition | undefined>;
}