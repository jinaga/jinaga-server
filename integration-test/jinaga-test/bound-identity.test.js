const { JinagaServer } = require("./jinaga-server");
const { parseSpecification } = require("./test-helpers");

// Issue #229, criterion 1. An identity condition between two labels that are
// both already bound was dropped from the generated SQL, so the condition read
// as "company has some office" rather than "office belongs to company". The
// conformance case's fixture cannot fail that, because its office and its
// company already match. These tests use an office of another company, so a
// dropped condition returns a row where it should return none.

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Each run uses its own type names, so one run's facts are not another's.
const suffix = Math.random().toString(36).slice(2, 10);
const companyType = `BI${suffix}.Company`;
const officeType = `BI${suffix}.Office`;

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

// The condition of the issue: the given office must belong to the given
// company. `o` is bound by its walk from `company`, and `office` is bound as a
// given, so `o = office` compares two facts the query has already written.
const identityLast = parseSpecification(`
    (office: ${officeType}, company: ${companyType} [
        E {
            o: ${officeType} [
                o->company: ${companyType} = company
                o = office
            ]
        }
    ]) {
    } => office
`);

// The same condition with the identity written first, which generated no SQL
// at all before the fix.
const identityFirst = parseSpecification(`
    (office: ${officeType}, company: ${companyType} [
        E {
            o: ${officeType} [
                o = office
                o->company: ${companyType} = company
            ]
        }
    ]) {
    } => office
`);

describe("An identity between two bound labels", () => {
    let j;
    let close;
    let ownCompany;
    let otherCompany;
    let ownOffice;
    let otherOffice;

    beforeEach(async () => {
        ({ j, close } = JinagaServer.create({
            pgKeystore: connectionString,
            pgStore: connectionString
        }));

        // Both companies have an office, so "company has some office" is true
        // of each. Only the identity distinguishes them.
        ownCompany = await j.fact(new Company("Own"));
        otherCompany = await j.fact(new Company("Other"));
        ownOffice = await j.fact(new Office(ownCompany, "OwnOffice"));
        otherOffice = await j.fact(new Office(otherCompany, "OtherOffice"));
    });

    afterEach(async () => {
        await close();
    });

    it("returns the office that belongs to the company", async () => {
        const results = await j.query(identityLast, ownOffice, ownCompany);

        expect(results.length).toBe(1);
        expect(results[0].identifier).toBe("OwnOffice");
    });

    it("returns no office of another company", async () => {
        const results = await j.query(identityLast, otherOffice, ownCompany);

        expect(results).toEqual([]);
    });

    it("returns the same rows with the identity written first", async () => {
        const matching = await j.query(identityFirst, ownOffice, ownCompany);
        const mismatched = await j.query(identityFirst, otherOffice, ownCompany);

        expect(matching.length).toBe(1);
        expect(matching[0].identifier).toBe("OwnOffice");
        expect(mismatched).toEqual([]);
    });
});
