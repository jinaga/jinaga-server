const { JinagaServer } = require("./jinaga-server");
const { parseSpecification } = require("./test-helpers");

// Issue #264. jinaga/jinaga.js#434 lets an existential condition join only a
// given of the enclosing query, so the condition no longer depends on the
// match it qualifies: `!E` returns every item while no lock on the root
// exists and none once one does, and `E` the reverse. These tests read the
// shape against PostgresStore before and after the lock is saved.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const rootType = `GOC${suffix}.Root`;
const scopeType = `GOC${suffix}.Scope`;
const itemType = `GOC${suffix}.Item`;
const lockType = `GOC${suffix}.Lock`;

// The condition joins only `r`, the query's only given.
const oneGiven = exists => parseSpecification(`
    (r: ${rootType}) {
        b: ${itemType} [
            b->root: ${rootType} = r
            ${exists} {
                a: ${lockType} [
                    a->root: ${rootType} = r
                ]
            }
        ]
    } => b
`);

// The condition joins only `s`, the second of two givens.
const twoGivens = exists => parseSpecification(`
    (r: ${rootType}, s: ${scopeType}) {
        b: ${itemType} [
            b->root: ${rootType} = r
            b->scope: ${scopeType} = s
            ${exists} {
                a: ${lockType} [
                    a->scope: ${scopeType} = s
                ]
            }
        ]
    } => b
`);

describe("A condition that joins only a given", () => {
    let j;
    let close;
    let root;
    let scope;

    beforeEach(async () => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore: connectionString
        }));

        // A fresh root and scope per test, so a lock saved by one test does
        // not hold for the next.
        const run = Math.random().toString(36).slice(2, 10);
        root = await j.fact({ type: rootType, identifier: run });
        scope = await j.fact({ type: scopeType, identifier: run });
        await j.fact({ type: itemType, name: "Item", root, scope });
        // A lock on ANOTHER root and scope must not hold for these.
        const otherRoot = await j.fact({ type: rootType, identifier: `${run}-other` });
        const otherScope = await j.fact({ type: scopeType, identifier: `${run}-other` });
        await j.fact({ type: lockType, root: otherRoot, scope: otherScope });
    });

    afterEach(async () => {
        await close();
    });

    function names(results) {
        return results.map(item => item.name);
    }

    it("returns the item while no lock on the given exists, and nothing once one does", async () => {
        expect(names(await j.query(oneGiven("!E"), root))).toEqual(["Item"]);
        expect(names(await j.query(oneGiven("E"), root))).toEqual([]);

        await j.fact({ type: lockType, root, scope });

        expect(names(await j.query(oneGiven("!E"), root))).toEqual([]);
        expect(names(await j.query(oneGiven("E"), root))).toEqual(["Item"]);
    });

    it("does the same for a condition on the second of two givens", async () => {
        expect(names(await j.query(twoGivens("!E"), root, scope))).toEqual(["Item"]);
        expect(names(await j.query(twoGivens("E"), root, scope))).toEqual([]);

        await j.fact({ type: lockType, root, scope });

        expect(names(await j.query(twoGivens("!E"), root, scope))).toEqual([]);
        expect(names(await j.query(twoGivens("E"), root, scope))).toEqual(["Item"]);
    });
});
