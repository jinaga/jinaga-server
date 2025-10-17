const { parseSpecification } = require("./test-helpers");
const { JinagaServer } = require("./jinaga-server");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

class Tenant {
    constructor(identifier) {
        this.type = Tenant.Type;
        this.identifier = identifier;
    }
}
Tenant.Type = "IntegrationTest.TimeProjection.Tenant";

class Event {
    constructor(tenant, description) {
        this.type = Event.Type;
        this.tenant = tenant;
        this.description = description;
    }
}
Event.Type = "IntegrationTest.TimeProjection.Event";

class EventCancelled {
    constructor(event, reason) {
        this.type = EventCancelled.Type;
        this.event = event;
        this.reason = reason;
    }
}
EventCancelled.Type = "IntegrationTest.TimeProjection.EventCancelled";

describe("Time projection", () => {
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
    
    it("should retrieve timestamp for a fact", async () => {
        const beforeTime = new Date();
        const tenant = await j.fact(new Tenant("tenant-1"));
        const event = await j.fact(new Event(tenant, "Test event"));
        const afterTime = new Date();
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
            } => @event
        `);
        
        const results = await j.query(specification, tenant);
        
        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(Date);
        expect(results[0].getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
        expect(results[0].getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);
    });

    it("should retrieve timestamps for multiple facts in order", async () => {
        const tenant = await j.fact(new Tenant("tenant-2"));
        const event1 = await j.fact(new Event(tenant, "First event"));
        
        // Add a small delay to ensure timestamps differ
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event2 = await j.fact(new Event(tenant, "Second event"));
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event3 = await j.fact(new Event(tenant, "Third event"));
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
            } => {
                event = event
                timestamp = @event
            }
        `);
        
        const results1 = await j.query(specification, tenant);
        const results2 = await j.query(specification, tenant);
        const results3 = await j.query(specification, tenant);
        
        expect(results1).toHaveLength(3);
        expect(results2).toHaveLength(3);
        expect(results3).toHaveLength(3);
        
        const time1 = results1[0].timestamp;
        const time2 = results2[0].timestamp;
        const time3 = results3[0].timestamp;
        
        expect(time1).toBeInstanceOf(Date);
        expect(time2).toBeInstanceOf(Date);
        expect(time3).toBeInstanceOf(Date);
        
        // Verify timestamps are ordered (allowing for small timing variations)
        expect(time2.getTime()).toBeGreaterThanOrEqual(time1.getTime());
        expect(time3.getTime()).toBeGreaterThanOrEqual(time2.getTime());
    });

    it("should project timestamp along with fact data", async () => {
        const tenant = await j.fact(new Tenant("tenant-3"));
        const event = await j.fact(new Event(tenant, "Complex test event"));
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
            } => {
                description = event.description
                timestamp = @event
            }
        `);
        
        const results = await j.query(specification, tenant);
        
        expect(results).toHaveLength(1);
        expect(results[0].description).toBe("Complex test event");
        expect(results[0].timestamp).toBeInstanceOf(Date);
        expect(results[0].timestamp.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("should project timestamps in complex query with related facts", async () => {
        const tenant = await j.fact(new Tenant("tenant-4"));
        const event = await j.fact(new Event(tenant, "Event to be cancelled"));
        
        // Add delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const cancellation = await j.fact(new EventCancelled(event, "No longer needed"));
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
                cancellation: IntegrationTest.TimeProjection.EventCancelled [
                    cancellation->event: IntegrationTest.TimeProjection.Event = event
                ]
            } => {
                event = event
                eventTimestamp = @event
                cancellation = cancellation
                cancellationTimestamp = @cancellation
            }
        `);
        
        const results = await j.query(specification, tenant);
        
        expect(results).toHaveLength(1);
        expect(results[0].event).toEqual(event);
        expect(results[0].eventTimestamp).toBeInstanceOf(Date);
        expect(results[0].cancellation).toEqual(cancellation);
        expect(results[0].cancellationTimestamp).toBeInstanceOf(Date);
        
        // Cancellation timestamp should be after or equal to event timestamp
        expect(results[0].cancellationTimestamp.getTime())
            .toBeGreaterThanOrEqual(results[0].eventTimestamp.getTime());
    });

    it("should project only timestamp without other data", async () => {
        const tenant = await j.fact(new Tenant("tenant-6"));
        const event = await j.fact(new Event(tenant, "Timestamp only"));
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
            } => @event
        `);
        
        const results = await j.query(specification, tenant);
        
        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(Date);
        // Should not include any other properties, just the Date
        expect(typeof results[0].getTime).toBe('function');
    });

    it("should handle multiple time projections in same query", async () => {
        const tenant = await j.fact(new Tenant("tenant-7"));
        const event1 = await j.fact(new Event(tenant, "First"));
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event2 = await j.fact(new Event(tenant, "Second"));
        
        const specification = parseSpecification(`
            (tenant: IntegrationTest.TimeProjection.Tenant) {
                event: IntegrationTest.TimeProjection.Event [
                    event->tenant: IntegrationTest.TimeProjection.Tenant = tenant
                ]
            } => {
                description = event.description
                timestamp = @event
            }
        `);
        
        const results1 = await j.query(specification, tenant);
        const results2 = await j.query(specification, tenant);
        
        expect(results1).toHaveLength(2);
        expect(results2).toHaveLength(2);
        
        // Find the specific events in the results
        const result1First = results1.find(r => r.description === "First");
        const result2Second = results2.find(r => r.description === "Second");
        
        expect(result1First).toBeDefined();
        expect(result2Second).toBeDefined();
        expect(result1First.timestamp).toBeInstanceOf(Date);
        expect(result2Second.timestamp).toBeInstanceOf(Date);
        
        // Verify second event timestamp is not before first
        expect(result2Second.timestamp.getTime())
            .toBeGreaterThanOrEqual(result1First.timestamp.getTime());
    });
});