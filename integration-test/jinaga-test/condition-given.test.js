const { JinagaServer } = require("./jinaga-server");
const { parseSpecification } = require("./test-helpers");

// Issue #235, criterion 3. A given that first appears inside an existential
// condition is an input of the condition, not of the query, so the enclosing
// scope has not written it. When the condition's first edge walked from that
// given, both SQL builders threw `Neither predecessor nor successor fact has
// been written`; the same condition with its two path conditions in the other
// order reaches the given through the tail joins and built. These tests read
// both orders against PostgresStore and require the same rows, so the order of
// two path conditions that mean the same thing stops changing the answer.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const siteType = `CG${suffix}.Site`;
const commentType = `CG${suffix}.Comment`;
const flagType = `CG${suffix}.Flag`;

class Site {
    constructor(identifier) {
        this.type = siteType;
        this.identifier = identifier;
    }
}

class Comment {
    // The root comment has no parent, so the field is left off rather than set
    // to null: a null predecessor is not a fact reference.
    constructor(text, parent) {
        this.type = commentType;
        this.text = text;
        if (parent) {
            this.parent = parent;
        }
    }
}

// A flag names a site and a comment. The condition asks whether the GIVEN site
// flagged the comment, so a flag naming another site must not satisfy it.
class Flag {
    constructor(site, comment) {
        this.type = flagType;
        this.site = site;
        this.comment = comment;
    }
}

// `site` is a given that only the condition uses, and the condition walks from
// it first. This is the form that threw.
const givenFirst = exists => parseSpecification(`
    (site: ${siteType}, parent: ${commentType}) {
        comment: ${commentType} [
            comment->parent: ${commentType} = parent
            ${exists} {
                flag: ${flagType} [
                    flag->site: ${siteType} = site
                    flag->comment: ${commentType} = comment
                ]
            }
        ]
    } => comment
`);

// The same condition with the two path conditions swapped. This form built
// before the fix, so it is the reference the other order has to match.
const givenLast = exists => parseSpecification(`
    (site: ${siteType}, parent: ${commentType}) {
        comment: ${commentType} [
            comment->parent: ${commentType} = parent
            ${exists} {
                flag: ${flagType} [
                    flag->comment: ${commentType} = comment
                    flag->site: ${siteType} = site
                ]
            }
        ]
    } => comment
`);

describe("A condition on a given only the condition uses", () => {
    let j;
    let close;
    let ownSite;
    let parent;

    // Criterion 3 asks for both kinds of flag: one that names BOTH givens, and
    // one that names only the comment among them. A third comment carries no
    // flag at all, which is the case a condition that lost its type and hash
    // pin still answers correctly, so it is the two flagged comments that
    // separate a working pin from a dropped one.
    //
    // `flagged` is created first, so it is the row an ORDER BY on fact_id
    // reaches first. A condition dropped altogether would therefore answer
    // `flagged` among the rest where the negative form excludes it.
    beforeEach(async () => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore: connectionString
        }));

        ownSite = await j.fact(new Site("Own"));
        const otherSite = await j.fact(new Site("Other"));
        parent = await j.fact(new Comment("Parent"));

        const flagged = await j.fact(new Comment("Flagged", parent));
        const flaggedElsewhere = await j.fact(new Comment("FlaggedElsewhere", parent));
        await j.fact(new Comment("Unflagged", parent));

        // Names both givens, so the condition holds for this comment.
        await j.fact(new Flag(ownSite, flagged));
        // Names the comment but another site, so among the two givens it names
        // only the comment, and the condition does not hold.
        await j.fact(new Flag(otherSite, flaggedElsewhere));
    });

    afterEach(async () => {
        await close();
    });

    function texts(results) {
        return results.map(comment => comment.text).sort();
    }

    it("excludes the comment the given site flagged, in both orders", async () => {
        const first = await j.query(givenFirst("!E"), ownSite, parent);
        const last = await j.query(givenLast("!E"), ownSite, parent);

        expect(texts(first)).toEqual(texts(last));
        expect(texts(first)).toEqual(["FlaggedElsewhere", "Unflagged"]);
    });

    it("includes the comment the given site flagged, in both orders", async () => {
        const first = await j.query(givenFirst("E"), ownSite, parent);
        const last = await j.query(givenLast("E"), ownSite, parent);

        expect(texts(first)).toEqual(texts(last));
        expect(texts(first)).toEqual(["Flagged"]);
    });
});
