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

// An anchor reaches a root through `r`, and another anchor through `a` or
// through `u`, or none of the three. Specification Q below walks `u` from a
// parent's anchor and `r` from a given the parent never reached.
class Anchor {
    constructor(r, a, u, identifier) {
        this.type = anchorType;
        this.r = r;
        this.a = a;
        this.u = u;
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

// Specification P of issue #233: a child that inherits only `u` and adds `c`
// reaching p1, so nothing joins the two chains until the grandchild. jinaga
// 6.17.0 refuses it in the parser (jinaga/jinaga.js#437), so it is held here
// as text and parsed inside the test that asserts the refusal. Parsing it at
// module scope, as this file did while the builders still answered it, would
// now fail the whole file on import.
const P_TEXT = `
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
`;

// Specification Q, which takes P's place against the stores (issue #251). Its
// child joins its parent's label `u` and also reaches p1, a given the parent
// never reached, so the child query allocates p1 as a new input. A new input
// lands among the inputs rather than after them, so the composer can only
// group each `c` under the `u` it belongs to by addressing its parent's labels
// by fact index. MemoryStore groups them from the specification directly, so
// it is the authority on what PostgresStore has to return.
const Q = parseSpecification(`
    (p1: ${rootType}, p2: ${anchorType}) {
        u: ${anchorType} [
            u->a: ${anchorType} = p2
        ]
    } => {
        k = {
            c: ${anchorType} [
                c->u: ${anchorType} = u
                c->r: ${rootType} = p1
            ]
        } => c
    }
`);

// The same graph is written to both stores: two `u` of p2, two `c` of p1, a
// join fact for one of the four pairs, and a join fact that succeeds a `c` of
// p1 together with an anchor that is not a `u` of p2. The second one is what
// distinguishes a correct answer from a query that joins on one chain only.
async function writeGraph(j) {
    const p1 = await j.fact(new Root("p1"));
    const p2 = await j.fact(new Anchor(null, null, null, "p2"));
    const u1 = await j.fact(new Anchor(null, p2, null, "u1"));
    const u2 = await j.fact(new Anchor(null, p2, null, "u2"));
    const c1 = await j.fact(new Anchor(p1, null, null, "c1"));
    const c2 = await j.fact(new Anchor(p1, null, null, "c2"));
    const stranger = await j.fact(new Anchor(null, null, null, "stranger"));
    await j.fact(new Join(c1, u1, "joins-c1-u1"));
    await j.fact(new Join(c2, stranger, "joins-c2-stranger"));

    // For Q: anchors that reach p1 through `r` and a `u` of p2 through `u`.
    // Two under u1 and one under u2, so a composer that grouped every child
    // row under the first parent row would put all three under u1 and leave
    // u2 empty. The last two must not appear at all: q4 never reaches p1, and
    // q5 reaches an anchor that is not a `u` of p2.
    await j.fact(new Anchor(p1, null, u1, "q1"));
    await j.fact(new Anchor(p1, null, u1, "q2"));
    await j.fact(new Anchor(p1, null, u2, "q3"));
    await j.fact(new Anchor(null, null, u1, "q4"));
    await j.fact(new Anchor(p1, null, stranger, "q5"));
    return { p1, p2 };
}

function identifiers(results) {
    return results.map(result => result.identifier);
}

// Q's projection names only `k`, so the `u` of a row is not in the result.
// What is observable is its shape: one entry per `u` of p2, and under it the
// `c` that reach both that `u` and p1.
function childIdentifiers(results) {
    return results.map(outer => identifiers(outer.k));
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

    it("refuses P, whose child is the product of two chains", () => {
        // The builders used to answer P with that product. Nothing in this
        // repository decides that any more: the parser does, before a query is
        // generated. Specification J above is connected and unaffected.
        expect(() => parseSpecification(P_TEXT)).toThrow(
            /a child specification of the projection would be the product of 2 chains/);
    });

    it("returns from Postgres the Q projection that MemoryStore returns", async () => {
        const fromPostgres = await pg.query(Q, pgGiven.p1, pgGiven.p2);
        const fromMemory = await memory.query(Q, memoryGiven.p1, memoryGiven.p2);

        expect(fromPostgres).toEqual(fromMemory);
    });

    it("groups each c of Q under the u it reaches", async () => {
        const fromPostgres = await pg.query(Q, pgGiven.p1, pgGiven.p2);

        // q1 and q2 reach u1; q3 reaches u2. q4 reaches u1 but not p1, and
        // q5 reaches p1 but no `u` of p2, so neither appears at all.
        expect(childIdentifiers(fromPostgres)).toEqual([
            ["q1", "q2"],
            ["q3"]
        ]);
    });
});
