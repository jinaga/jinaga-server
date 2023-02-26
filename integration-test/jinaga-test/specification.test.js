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
  constructor(company, number) {
    this.type = Employee.Type;
    this.company = company;
    this.number = number;
  }
}
Employee.Type = "IntegrationTest.Employee";

class EmployeeName {
  constructor(employee, value, prior) {
    this.type = EmployeeName.Type;
    this.employee = employee;
    this.value = value;
    this.prior = prior;
  }
}
EmployeeName.Type = "IntegrationTest.EmployeeName";

const model = buildModel(b => b
  .type(Company)
  .type(Employee, f => f
    .predecessor("company", Company)
  )
  .type(EmployeeName, f => f
    .predecessor("employee", Employee)
    .predecessor("prior", EmployeeName)
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
    const employee = new Employee(company, "124151");

    // No facts were stored in the database.
    const results = await j.query(model.given(Employee).match((employee, facts) =>
      facts.ofType(Company)
        .join(company => company, employee.company)
    ), employee);

    expect(results).toEqual([]);
  });

  it("should accept an unknown successor", async () => {
    const company = await j.fact(new Company("Acme"));
    const employee = new Employee(company, "566346");

    // The employee name type is not in the database.
    const results = await j.query(model.given(Company). match((company, facts) =>
      facts.ofType(Employee)
        .join(employee => employee.company, company)
    ), company);

    expect(results).toEqual([]);
  });

  it("should accept an unknown existential condition", async () => {
    const company = await j.fact(new Company("Acme"));
    const employee = new Employee(company, "386825");

    // The employee type is not in the database.
    const results = await j.query(model.given(Company).match((company, facts) =>
      facts.ofType(Employee)
        .join(employee => employee.company, company)
        .selectMany(employee => facts.ofType(EmployeeName)
          .join(name => name.employee, employee)
          .notExists(name => facts.ofType(EmployeeName)
            .join(next => next.prior, name)
          )
        )
    ), company);

    expect(results).toEqual([]);
  });

  it("should accept everything unknown", async () => {
    const company = new Company("Acme");
    const employee = new Employee(company, "124151");

    // No facts were stored in the database.
    const results = await j.query(model.given(Employee).match((employee, facts) =>
      facts.ofType(EmployeeName)
        .join(name => name.employee, employee)
        .notExists(name => facts.ofType(EmployeeName)
          .join(next => next.prior, name)
        )
    ), employee);

    expect(results).toEqual([]);
  });
});