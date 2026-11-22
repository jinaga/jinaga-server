import {
    buildFeeds,
    FeedObject,
    ReferencesByName,
    SpecificationParser
} from "jinaga";

import { instanceKey, shapeKey } from "../../src/feeds/feed-identity";

const alphaHash = "alphahash00000000000000000000000000000000000000";
const betaHash = "betahash000000000000000000000000000000000000000";

// Parse a feed the way the router does: declare the start facts, parse the
// specification, then decompose it into feeds and keep the first one.
function parseFeed(input: string): FeedObject {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    const declaration = parser.parseDeclaration([]);
    const specification = parser.parseSpecification();
    const namedStart = specification.given.reduce((map, g) => ({
        ...map,
        [g.label.name]: declaration.find(d => d.name === g.label.name)!.declared.reference
    }), {} as ReferencesByName);
    return {
        feed: buildFeeds(specification)[0],
        namedStart
    };
}

// The same question, asked about the author at `hash`, with the labels
// named by the caller. Everything else is identical.
function postsByAuthor(hash: string, author: string, post: string): FeedObject {
    return parseFeed(
        `let ${author}: Jinaga.User = #${hash}\n` +
        `(${author}: Jinaga.User) {\n` +
        `    ${post}: Identity.Post [\n` +
        `        ${post}->author: Jinaga.User = ${author}\n` +
        `    ]\n` +
        `} => ${post}`);
}

describe("feed identity", () => {
    it("gives two feeds that differ only in label names one shape key", () => {
        const named = postsByAuthor(alphaHash, "p", "post");
        const renamed = postsByAuthor(alphaHash, "author", "article");

        expect(shapeKey(renamed.feed)).toBe(shapeKey(named.feed));
    });

    it("gives two feeds that differ only in label names one instance key", () => {
        const named = postsByAuthor(alphaHash, "p", "post");
        const renamed = postsByAuthor(alphaHash, "author", "article");

        expect(instanceKey(renamed.feed, renamed.namedStart))
            .toBe(instanceKey(named.feed, named.namedStart));
    });

    it("gives one feed read from two starts one shape key and two instance keys", () => {
        const alpha = postsByAuthor(alphaHash, "p", "post");
        const beta = postsByAuthor(betaHash, "p", "post");

        expect(shapeKey(beta.feed)).toBe(shapeKey(alpha.feed));
        expect(instanceKey(beta.feed, beta.namedStart))
            .not.toBe(instanceKey(alpha.feed, alpha.namedStart));
    });

    it("gives two different questions two shape keys", () => {
        const posts = postsByAuthor(alphaHash, "p", "post");
        const comments = parseFeed(
            `let p: Jinaga.User = #${alphaHash}\n` +
            `(p: Jinaga.User) {\n` +
            `    comment: Identity.Comment [\n` +
            `        comment->author: Jinaga.User = p\n` +
            `    ]\n` +
            `} => comment`);

        expect(shapeKey(comments.feed)).not.toBe(shapeKey(posts.feed));
    });

    it("carries both keys in a URL path segment", () => {
        const feed = postsByAuthor(alphaHash, "p", "post");

        for (const key of [shapeKey(feed.feed), instanceKey(feed.feed, feed.namedStart)]) {
            expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(encodeURIComponent(key)).toBe(key);
        }
    });
});
