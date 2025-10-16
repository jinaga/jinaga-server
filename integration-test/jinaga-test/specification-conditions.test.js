const { SpecificationParser, SpecificationOf } = require("jinaga");
const { JinagaServer } = require("./jinaga-server");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

class Department {
  constructor(identifier) {
    this.type = Department.Type;
    this.identifier = identifier;
  }
}
Department.Type = "IntegrationTest.Conditions.Department";

class DepartmentActive {
  constructor(department) {
    this.type = DepartmentActive.Type;
    this.department = department;
  }
}
DepartmentActive.Type = "IntegrationTest.Conditions.DepartmentActive";

class Employee {
  constructor(department, employeeId) {
    this.type = Employee.Type;
    this.department = department;
    this.employeeId = employeeId;
  }
}
Employee.Type = "IntegrationTest.Conditions.Employee";

function parseSpecification(input) {
  const parser = new SpecificationParser(input);
  parser.skipWhitespace();
  const spec = parser.parseSpecification();
  // Wrap the parsed specification in a SpecificationOf object
  return new SpecificationOf(spec);
}

describe("Specifications with conditions", () => {
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

  it("should return employees when department is active (has DepartmentActive fact)", async () => {
    // Create an active department (has DepartmentActive marker fact)
    const department = await j.fact(new Department("HR-001"));
    await j.fact(new DepartmentActive(department));
    
    // Add employees to the department
    await j.fact(new Employee(department, "EMP-001"));
    await j.fact(new Employee(department, "EMP-002"));

    // Query with positive existential condition: only return employees for departments that HAVE an active marker
    const specification = parseSpecification(`
      (department: IntegrationTest.Conditions.Department [
        E {
          active: IntegrationTest.Conditions.DepartmentActive [
            active->department: IntegrationTest.Conditions.Department = department
          ]
        }
      ]) {
        employee: IntegrationTest.Conditions.Employee [
          employee->department: IntegrationTest.Conditions.Department = department
        ]
      } => employee
    `);

    const results = await j.query(specification, department);

    // Should return both employees since department has active marker
    expect(results.length).toBe(2);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: "EMP-001" }),
        expect.objectContaining({ employeeId: "EMP-002" })
      ])
    );
  });

  it("should NOT return employees for inactive department (with positive existential condition)", async () => {
    // Create an inactive department (no DepartmentActive marker fact)
    const department = await j.fact(new Department("HR-002"));
    
    // Add employees to the department
    await j.fact(new Employee(department, "EMP-003"));
    await j.fact(new Employee(department, "EMP-004"));

    // Query with positive existential condition: only return employees for departments that HAVE an active marker
    const specification = parseSpecification(`
      (department: IntegrationTest.Conditions.Department [
        E {
          active: IntegrationTest.Conditions.DepartmentActive [
            active->department: IntegrationTest.Conditions.Department = department
          ]
        }
      ]) {
        employee: IntegrationTest.Conditions.Employee [
          employee->department: IntegrationTest.Conditions.Department = department
        ]
      } => employee
    `);

    const results = await j.query(specification, department);

    // Should return NO employees since department has no active marker
    expect(results).toEqual([]);
  });

  it("should return employees for inactive department using negative existential condition", async () => {
    // Create two departments: one active, one inactive
    const activeDept = await j.fact(new Department("HR-ACTIVE"));
    await j.fact(new DepartmentActive(activeDept));
    await j.fact(new Employee(activeDept, "EMP-ACTIVE-1"));
    
    const inactiveDept = await j.fact(new Department("HR-INACTIVE"));
    // No DepartmentActive fact for this one
    await j.fact(new Employee(inactiveDept, "EMP-INACTIVE-1"));

    // Query with negative existential condition: only return employees for departments that DON'T HAVE an active marker
    const specification = parseSpecification(`
      (department: IntegrationTest.Conditions.Department [
        !E {
          active: IntegrationTest.Conditions.DepartmentActive [
            active->department: IntegrationTest.Conditions.Department = department
          ]
        }
      ]) {
        employee: IntegrationTest.Conditions.Employee [
          employee->department: IntegrationTest.Conditions.Department = department
        ]
      } => employee
    `);

    // Query active department - should return NO employees (has active marker, condition excludes it)
    const activeResults = await j.query(specification, activeDept);
    expect(activeResults).toEqual([]);

    // Query inactive department - should return employees (no active marker, condition includes it)
    const inactiveResults = await j.query(specification, inactiveDept);
    expect(inactiveResults.length).toBe(1);
    expect(inactiveResults[0]).toEqual(expect.objectContaining({ employeeId: "EMP-INACTIVE-1" }));
  });
});