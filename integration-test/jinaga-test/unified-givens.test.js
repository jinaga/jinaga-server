const { JinagaServer } = require("./jinaga-server");
const { parseSpecification } = require("./test-helpers");

// Issue #232, criterion 2. A match whose identities bind two givens to one
// unknown unifies both onto a single fact index, which is the right
// description: the fact must satisfy both type-and-hash filters, so the read
// returns it only when the two givens are the same fact. The match has no
// roles, so the query has no edges and the FROM clause comes from
// `joinGivens`, which emitted one CROSS JOIN per input after the first without
// checking whether that input's fact index was already in the FROM clause. The
// alias appeared twice and Postgres rejected the statement with
// `table name "f1" specified more than once`, so neither read below could run
// at all.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const companyType = `UG${suffix}.Company`;
const officeType = `UG${suffix}.Office`;

class Company {
    constructor(identifier) {
        this.type = companyType;
        this.identifier = identifier;
    }
}

class Office {
    constructor(company, identifier) {
        this.type = officeType;
        this.company = company;
        this.identifier = identifier;
    }
}

const sameFact = parseSpecification(`
    (office: ${officeType}, other: ${officeType}) {
        o: ${officeType} [
            o = office
            o = other
        ]
    } => o
`);

describe("Two givens unified onto one fact", () => {
    let j;
    let close;
    let office;
    let otherOffice;

    beforeEach(async () => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore: connectionString
        }));

        const company = await j.fact(new Company("Unified"));
        office = await j.fact(new Office(company, "Office"));
        otherOffice = await j.fact(new Office(company, "OtherOffice"));
    });

    afterEach(async () => {
        await close();
    });

    it("returns the fact when both givens are the same fact", async () => {
        const results = await j.query(sameFact, office, office);

        expect(results.length).toBe(1);
        expect(results[0].identifier).toBe("Office");
    });

    it("returns no rows when the givens are different facts", async () => {
        const results = await j.query(sameFact, office, otherOffice);

        expect(results).toEqual([]);
    });
});
