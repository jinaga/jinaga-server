const { JinagaTest } = require("jinaga");
const { JinagaServer } = require("./jinaga-server");
const { parseSpecification } = require("./test-helpers");

// Issue #233. Both SQL builders seeded the FROM clause with the one given that
// the first edge touches, so a specification whose later match walks from a
// second given threw "Neither predecessor nor successor fact has been
// written". MemoryStore answers both specifications below, so PostgresStore
// has to return the same rows.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const rootType = `SG${suffix}.R`;
const anchorType = `SG${suffix}.A`;
const joinType = `SG${suffix}.B`;

class Root {
    constructor(identifier) {
        this.type = rootType;
        this.identifier = identifier;
    }
}

// An anchor reaches a root through `r`, another anchor through `a`, or neither.
class Anchor {
    constructor(r, a, identifier) {
        this.type = anchorType;
        this.r = r;
        this.a = a;
        this.identifier = identifier;
    }
}

// A join fact succeeds two anchors, one from each chain.
class Join {
    constructor(c, u, identifier) {
        this.type = joinType;
        this.c = c;
        this.u = u;
        this.identifier = identifier;
    }
}

// Specification J of the issue: two givens, each reached by its own chain,
// joined by the last match.
const J = parseSpecification(`
    (p1: ${rootType}, p2: ${anchorType}) {
        u: ${anchorType} [
            u->a: ${anchorType} = p2
        ]
        c: ${anchorType} [
            c->r: ${rootType} = p1
        ]
        x: ${joinType} [
            x->c: ${anchorType} = c
            x->u: ${anchorType} = u
        ]
    } => x
`);

// Specification P of the issue: a child feed that is the product of two
// chains, with no match joining them until the grandchild.
const P = parseSpecification(`
    (p1: ${rootType}, p2: ${anchorType}) {
        u: ${anchorType} [
            u->a: ${anchorType} = p2
        ]
    } => {
        k = {
            c: ${anchorType} [
                c->r: ${rootType} = p1
            ]
        } => {
            g = {
                x: ${joinType} [
                    x->c: ${anchorType} = c
                    x->u: ${anchorType} = u
                ]
            } => x
        }
    }
`);

// The same graph is written to both stores: two `u` of p2, two `c` of p1, a
// join fact for one of the four pairs, and a join fact that succeeds a `c` of
// p1 together with an anchor that is not a `u` of p2. The second one is what
// distinguishes a correct answer from a query that joins on one chain only.
async function writeGraph(j) {
    const p1 = await j.fact(new Root("p1"));
    const p2 = await j.fact(new Anchor(null, null, "p2"));
    const u1 = await j.fact(new Anchor(null, p2, "u1"));
    await j.fact(new Anchor(null, p2, "u2"));
    const c1 = await j.fact(new Anchor(p1, null, "c1"));
    const c2 = await j.fact(new Anchor(p1, null, "c2"));
    const stranger = await j.fact(new Anchor(null, null, "stranger"));
    await j.fact(new Join(c1, u1, "joins-c1-u1"));
    await j.fact(new Join(c2, stranger, "joins-c2-stranger"));
    return { p1, p2 };
}

function identifiers(results) {
    return results.map(result => result.identifier);
}

// P's projection names only `k` and, under it, `g`, so the `u` and the `c` of
// a row are not in the result. What is observable is its shape: one entry per
// `u` of p2, under it one entry per `c` of p1, and under each pair the joins.
function joinsByPair(results) {
    return results.map(outer => outer.k.map(middle => identifiers(middle.g)));
}

describe("A specification that walks from a second given", () => {
    let pg;
    let closePg;
    let pgGiven;
    let memory;
    let memoryGiven;

    beforeEach(async () => {
        ({ j: pg, close: closePg } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore: connectionString
        }));
        pgGiven = await writeGraph(pg);

        memory = JinagaTest.create({});
        memoryGiven = await writeGraph(memory);
    });

    afterEach(async () => {
        await closePg();
    });

    it("returns from Postgres the J rows that MemoryStore returns", async () => {
        const fromPostgres = await pg.query(J, pgGiven.p1, pgGiven.p2);
        const fromMemory = await memory.query(J, memoryGiven.p1, memoryGiven.p2);

        expect(identifiers(fromPostgres)).toEqual(identifiers(fromMemory));
    });

    it("returns for J only the join fact that succeeds a c of p1 and a u of p2", async () => {
        const fromPostgres = await pg.query(J, pgGiven.p1, pgGiven.p2);

        // joins-c2-stranger succeeds a c of p1 but no u of p2, so a query that
        // joined on one chain only would return it here.
        expect(identifiers(fromPostgres)).toEqual(["joins-c1-u1"]);
    });

    it("returns from Postgres the P projection that MemoryStore returns", async () => {
        const fromPostgres = await pg.query(P, pgGiven.p1, pgGiven.p2);
        const fromMemory = await memory.query(P, memoryGiven.p1, memoryGiven.p2);

        expect(fromPostgres).toEqual(fromMemory);
    });

    it("pairs every u of p2 with every c of p1 in P, and joins each pair under it", async () => {
        const fromPostgres = await pg.query(P, pgGiven.p1, pgGiven.p2);

        // Two `u` of p2, each paired with both `c` of p1. Only the pair
        // (u1, c1) has a join fact.
        expect(joinsByPair(fromPostgres)).toEqual([
            [["joins-c1-u1"], []],
            [[], []]
        ]);
    });
});
