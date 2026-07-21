import { buildFeeds, dehydrateReference, getAllFactTypes, getAllRoles, Specification, SpecificationParser } from "jinaga";

import { addFactType, addRole, emptyFactTypeMap, emptyRoleMap, FactTypeMap, getFactTypeId, RoleMap } from "../../src/postgres/maps";
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

function parseSpecification(input: string): Specification {
    const parser = new SpecificationParser(input);
    parser.skipWhitespace();
    return parser.parseSpecification();
}

function buildMaps(specification: Specification): { factTypes: FactTypeMap; roleMap: RoleMap } {
    // Assign deterministic type ids in first-seen order so two specifications
    // with the same shape but different type names produce identical parameter
    // sequences. Filter the synthetic "Unknown" fact type and "unknown" role
    // name (matching the other Postgres SQL generator specs) so they cannot
    // shift the id assignment. Roles get ids offset well past the type ids.
    const factTypes = getAllFactTypes(specification)
        .filter(factType => factType !== 'Unknown')
        .reduce((f, factType, i) => addFactType(f, factType, i + 1), emptyFactTypeMap());
    const roleMap = getAllRoles(specification)
        .filter(role => role.name !== 'unknown')
        .reduce((r, role, i) => {
            const factTypeId = getFactTypeId(factTypes, role.successorType);
            if (!factTypeId) {
                return r;
            }
            return addRole(r, factTypeId, role.name, i + 100);
        }, emptyRoleMap());
    return { factTypes, roleMap };
}

// Pure: generates the feed SQL for a single-feed specification. All assertions
// live in the tests (or beforeAll) so a parse/build failure surfaces as a test
// failure rather than a suite-collection error.
function feedSqlFor(descriptiveString: string, startType: string) {
    const specification = parseSpecification(descriptiveString);
    const { factTypes, roleMap } = buildMaps(specification);
    const feeds = buildFeeds(specification);
    const start = [dehydrateReference({ type: startType, key: "value" })];
    const query = sqlFromFeed(feeds[0], start, "public", "", 100, factTypes, roleMap);
    return { query, feedCount: feeds.length, factTypes };
}

// The canonical "owned by me" shape: a successor edged to the given user
// through a role named `owner`.
const USER_GIVEN_SPEC = `
    (user: Jinaga.User) {
        activity: Networking.Activity [
            activity->owner: Jinaga.User = user
        ]
    }`;

// The identical join shape rooted at a non-user given.
const ACTIVITY_GIVEN_SPEC = `
    (activity: Networking.Activity) {
        log: Networking.ActivityCrmLog [
            log->activity: Networking.Activity = activity
        ]
    }`;

describe("Jinaga.User-given feed SQL (issue #179)", () => {
    let userGiven: ReturnType<typeof feedSqlFor>;
    let activityGiven: ReturnType<typeof feedSqlFor>;

    beforeAll(() => {
        userGiven = feedSqlFor(USER_GIVEN_SPEC, "Jinaga.User");
        activityGiven = feedSqlFor(ACTIVITY_GIVEN_SPEC, "Networking.Activity");
        // Both shapes must reduce to a single feed for the comparison to be
        // apples-to-apples.
        expect(userGiven.feedCount).toBe(1);
        expect(activityGiven.feedCount).toBe(1);
    });

    it("produces a satisfiable, single feed query for a Jinaga.User given", () => {
        // A satisfiable query is the whole point: a null query here would be
        // the silent-empty the issue describes. The given's type is loaded and
        // the predecessor edge on `owner` is generated.
        expect(userGiven.query).not.toBeNull();
        expect(userGiven.query!.sql).toContain("f1.fact_type_id = $1 AND f1.hash = $2");
        expect(userGiven.query!.sql).toContain("public.edge");
        expect(userGiven.query!.labels.length).toBe(1);
    });

    it("generates SQL structurally identical to a non-user given of the same shape", () => {
        // No Jinaga.User special-casing: the two SQL strings match exactly.
        expect(userGiven.query).not.toBeNull();
        expect(activityGiven.query).not.toBeNull();
        expect(userGiven.query!.sql).toEqual(activityGiven.query!.sql);
    });

    it("binds the given type id (from the fact-type map) and hash as the leading parameters", () => {
        // The given fact type participates in the WHERE clause like any other —
        // it is not dropped or defaulted to a constant for Jinaga.User. Derive
        // the expected id from the map built for this spec so the assertion is
        // not coupled to getAllFactTypes ordering.
        const userReference = dehydrateReference({ type: "Jinaga.User", key: "value" });
        const expectedTypeId = getFactTypeId(userGiven.factTypes, "Jinaga.User");
        expect(expectedTypeId).toBeDefined();
        expect(userGiven.query).not.toBeNull();
        expect(userGiven.query!.parameters[0]).toBe(expectedTypeId);
        expect(userGiven.query!.parameters[1]).toBe(userReference.hash);
    });
});
