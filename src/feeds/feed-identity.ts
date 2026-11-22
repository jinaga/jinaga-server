import {
    computeObjectHash,
    FactReference,
    FeedObject,
    ReferencesByName,
    skeletonOfSpecification,
    Specification
} from "jinaga";

/**
 * The identity of a feed, at the two grains the feed-log series reasons
 * about.
 *
 * A **shape** is a feed specification with its labels and its start facts
 * abstracted away: every subscription that asks the same question of the
 * graph shares one shape, whatever it asks the question about and whatever
 * its author named the labels. An **instance** is a shape together with the
 * facts the question starts from, which is what a client actually
 * subscribes to and what a feed log would be kept for.
 *
 * These are the only definitions of feed identity in the series. A reader
 * that needs either key calls one of these functions rather than spelling
 * the derivation again.
 */

/**
 * Carry a hash where a URL path segment or a metric name can hold it, the
 * way `computeFeedHash` in jinaga does for the hash on the wire.
 */
function urlSafe(hash: string): string {
    return hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function keyOf(value: {}): string {
    return urlSafe(computeObjectHash(value));
}

/**
 * The key of a feed's shape: the hash of its skeleton.
 *
 * The skeleton carries fact types, edge roles and the structure of the
 * query, and carries no label names, so two specifications that differ
 * only in what their labels are called have one shape key.
 *
 * Two specifications whose matches are written in a different order still
 * produce different skeletons today. jinaga/jinaga.js#362 tracks that; when
 * it ships, the skeleton canonicalizes and this key follows it with no
 * change here.
 */
export function shapeKey(feed: Specification): string {
    return keyOf(skeletonOfSpecification(feed));
}

/**
 * The key of a feed instance: its shape key together with the facts it
 * starts from.
 *
 * The start references are taken in skeleton input order rather than in
 * the order the specification happens to declare its givens, so the key
 * does not move when a reader reaches the same feed by another path.
 */
export function instanceKey(feed: Specification, namedStart: ReferencesByName): string {
    const skeleton = skeletonOfSpecification(feed);
    const start: FactReference[] = skeleton.inputs.map(input =>
        namedStart[feed.given[input.inputIndex].label.name]);
    return keyOf({
        shape: shapeKey(feed),
        start
    });
}

/** Both keys of the feed a {@link FeedObject} describes. */
export interface FeedKeys {
    shapeKey: string;
    instanceKey: string;
}

/**
 * The keys of the feed a registered subscription names. This is the one
 * composition of the two keys above, so a caller that accounts for a read
 * and a caller that accounts for a streaming session agree on both.
 */
export function feedKeys(feedDefinition: FeedObject): FeedKeys {
    return {
        shapeKey: shapeKey(feedDefinition.feed),
        instanceKey: instanceKey(feedDefinition.feed, feedDefinition.namedStart)
    };
}
