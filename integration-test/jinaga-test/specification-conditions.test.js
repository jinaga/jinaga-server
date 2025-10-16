const { buildModel } = require("jinaga");
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

const model = buildModel(b => b
  .type(Department)
  .type(DepartmentActive, f => f
    .predecessor("department", Department)
  )
  .type(Employee, f => f
    .predecessor("department", Department)
  )
);

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

    // Simple query: get all employees for this department
    const results = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(Employee)
        .join(employee => employee.department, department)
    ), department);

    // Should return both employees
    expect(results.length).toBe(2);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: "EMP-001" }),
        expect.objectContaining({ employeeId: "EMP-002" })
      ])
    );
    
    // Verify the department has an active marker
    const activeMarkers = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(DepartmentActive)
        .join(active => active.department, department)
    ), department);
    
    expect(activeMarkers.length).toBe(1);
  });

  it("should return employees for inactive department too (no condition applied)", async () => {
    // Create an inactive department (no DepartmentActive marker fact)
    const department = await j.fact(new Department("HR-002"));
    
    // Add employees to the department
    await j.fact(new Employee(department, "EMP-003"));
    await j.fact(new Employee(department, "EMP-004"));

    // Same query: get all employees for this department
    const results = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(Employee)
        .join(employee => employee.department, department)
    ), department);

    // Should still return employees (no condition filtering them out)
    expect(results.length).toBe(2);
    
    // Verify the department has NO active marker
    const activeMarkers = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(DepartmentActive)
        .join(active => active.department, department)
    ), department);
    
    expect(activeMarkers).toEqual([]);
  });

  it("should demonstrate existential condition - departments WITH active markers", async () => {
    // Create two departments: one active, one inactive
    const activeDept = await j.fact(new Department("HR-ACTIVE"));
    await j.fact(new DepartmentActive(activeDept));
    await j.fact(new Employee(activeDept, "EMP-ACTIVE-1"));
    
    const inactiveDept = await j.fact(new Department("HR-INACTIVE"));
    // No DepartmentActive fact for this one
    await j.fact(new Employee(inactiveDept, "EMP-INACTIVE-1"));

    // Query active department - should find the active marker
    const activeMarkers = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(DepartmentActive)
        .join(active => active.department, department)
    ), activeDept);
    expect(activeMarkers.length).toBe(1);

    // Query inactive department - should find NO active marker
    const inactiveMarkers = await j.query(model.given(Department).match((department, facts) =>
      facts.ofType(DepartmentActive)
        .join(active => active.department, department)
    ), inactiveDept);
    expect(inactiveMarkers).toEqual([]);
  });
});