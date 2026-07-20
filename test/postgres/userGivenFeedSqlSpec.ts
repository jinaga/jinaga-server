import { buildFeeds, dehydrateReference, getAllFactTypes, getAllRoles, SpecificationParser } from "jinaga";

import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, getFactTypeId } from "../../src/postgres/maps";
import { sqlFromFeed } from "../../src/postgres/specification-sql";

// Regression coverage for jinaga-server#179.
//
// The issue named two candidate loci for a `Jinaga.User`-given feed returning
// empty despite matching data: the distribution decision (jinaga.js) and the
// Postgres feed SQL (this repo, `sqlFromFeed`). These tests pin down the
// second: the feed SQL generated for a specification whose given is typed
// `Jinaga.User` is structurally identical to the SQL for the same join shape
// against any other given type. There is no `Jinaga.User` special-casing in
// jinaga-server's query generation, so the empty-result trigger does not live
// here.

function parseSpecification(input: string) {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function buildMaps(specification: ReturnType<typeof parseSpecification>) {
    // Assign deterministic type ids in first-seen order so two specifications
    // with the same shape but different type names produce identical parameter
    // sequences. Roles get ids offset well past the type ids to avoid overlap.
    const factTypes = getAllFactTypes(specification).reduce(
        (f, factType, i) => addFactType(f, factType, i + 1),
        emptyFactTypeMap());
    const roleMap = getAllRoles(specification).reduce(
        (r, role, i) => {
            const factTypeId = getFactTypeId(factTypes, role.successorType);
            if (!factTypeId) {
                return r;
            }
            return addRole(r, factTypeId, role.name, i + 100);
        },
        emptyRoleMap());
    return { factTypes, roleMap };
}

function feedSqlFor(descriptiveString: string, startType: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = buildMaps(specification);
    const feeds = buildFeeds(specification);
    expect(feeds.length).toBe(1);
    const start = [dehydrateReference({ type: startType, key: "value" })];
    const query = sqlFromFeed(feeds[0], start, "public", "", 100, factTypes, roleMap);
    expect(query).not.toBeNull();
    return query!;
}

describe("Jinaga.User-given feed SQL (issue #179)", () => {
    // The canonical "owned by me" shape: a successor edged to the given user
    // through a role named `owner`.
    const userGiven = feedSqlFor(`
        (user: Jinaga.User) {
            activity: Networking.Activity [
                activity->owner: Jinaga.User = user
            ]
        }`, "Jinaga.User");

    // The identical join shape rooted at a non-user given.
    const activityGiven = feedSqlFor(`
        (activity: Networking.Activity) {
            log: Networking.ActivityCrmLog [
                log->activity: Networking.Activity = activity
            ]
        }`, "Networking.Activity");

    it("produces a satisfiable, single feed query for a Jinaga.User given", () => {
        // A satisfiable query is the whole point: a null/empty query here would
        // be the silent-empty the issue describes. The given's type is loaded
        // and the predecessor edge on `owner` is generated.
        expect(userGiven.sql).toContain("f1.fact_type_id = $1 AND f1.hash = $2");
        expect(userGiven.sql).toContain("public.edge");
        expect(userGiven.labels.length).toBe(1);
    });

    it("generates SQL structurally identical to a non-user given of the same shape", () => {
        // No Jinaga.User special-casing: the two SQL strings match exactly.
        expect(userGiven.sql).toEqual(activityGiven.sql);
    });

    it("binds the given type id and hash as the leading parameters, not a constant", () => {
        // The given fact type participates in the WHERE clause like any other —
        // it is not dropped or defaulted to 0 for Jinaga.User.
        const userReference = dehydrateReference({ type: "Jinaga.User", key: "value" });
        expect(userGiven.parameters[0]).toBe(1);
        expect(userGiven.parameters[1]).toBe(userReference.hash);
    });
});
