const { buildModel } = require("jinaga");
const { JinagaServer } = require("./jinaga-server");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

class Company {
  constructor(name) {
    this.type = Company.Type;
    this.name = name;
  }
}
Company.Type = "IntegrationTest.Company";

class Employee {
  constructor(company, name) {
    this.type = Employee.Type;
    this.company = company;
    this.name = name;
  }
}
Employee.Type = "IntegrationTest.Employee";

const model = buildModel(b => b
  .type(Company)
  .type(Employee, f => f
    .predecessor("company", Company)
  )
);

describe("Query from specification", () => {
  let j;
  let close;

  beforeEach(() => {
      ({ j, close } = JinagaServer.create({
          pgKeystore: connectionString,
          pgStore:    connectionString
      }));
  });

  afterEach(async () => {
      await close();
  });

  it("should accept an unknown given", async () => {
    const company = new Company("Acme");
    const employee = new Employee(company, "Bob");

    // No facts were stored in the database.
    const results = await j.query(model.given(Employee).match((employee, facts) =>
      facts.ofType(Company)
        .join(company => company, employee.company)
    ), employee);

    expect(results).toEqual([]);
  });
});