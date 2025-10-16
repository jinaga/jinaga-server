const { parseSpecification } = require("./test-helpers");
const { JinagaServer } = require("./jinaga-server");

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

class Event {
    constructor(identifier, description) {
        this.type = Event.Type;
        this.identifier = identifier;
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
        const event = await j.fact(new Event("event-1", "Test event"));
        const afterTime = new Date();
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
            } => @event
        `);
        
        const results = await j.query(specification, event);
        
        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(Date);
        expect(results[0].getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
        expect(results[0].getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);
    });

    it("should retrieve timestamps for multiple facts in order", async () => {
        const event1 = await j.fact(new Event("event-1", "First event"));
        
        // Add a small delay to ensure timestamps differ
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event2 = await j.fact(new Event("event-2", "Second event"));
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event3 = await j.fact(new Event("event-3", "Third event"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
            } => {
                event = event,
                timestamp = @event
            }
        `);
        
        const results1 = await j.query(specification, event1);
        const results2 = await j.query(specification, event2);
        const results3 = await j.query(specification, event3);
        
        expect(results1).toHaveLength(1);
        expect(results2).toHaveLength(1);
        expect(results3).toHaveLength(1);
        
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
        const event = await j.fact(new Event("event-complex", "Complex test event"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
            } => {
                identifier = event.identifier,
                description = event.description,
                timestamp = @event
            }
        `);
        
        const results = await j.query(specification, event);
        
        expect(results).toHaveLength(1);
        expect(results[0].identifier).toBe("event-complex");
        expect(results[0].description).toBe("Complex test event");
        expect(results[0].timestamp).toBeInstanceOf(Date);
        expect(results[0].timestamp.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("should project timestamps in complex query with related facts", async () => {
        const event = await j.fact(new Event("event-4", "Event to be cancelled"));
        
        // Add delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const cancellation = await j.fact(new EventCancelled(event, "No longer needed"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
                cancellation: IntegrationTest.TimeProjection.EventCancelled [
                    cancellation->event: IntegrationTest.TimeProjection.Event = event
                ]
            } => {
                event = event,
                eventTimestamp = @event,
                cancellation = cancellation,
                cancellationTimestamp = @cancellation
            }
        `);
        
        const results = await j.query(specification, event);
        
        expect(results).toHaveLength(1);
        expect(results[0].event).toEqual(event);
        expect(results[0].eventTimestamp).toBeInstanceOf(Date);
        expect(results[0].cancellation).toEqual(cancellation);
        expect(results[0].cancellationTimestamp).toBeInstanceOf(Date);
        
        // Cancellation timestamp should be after or equal to event timestamp
        expect(results[0].cancellationTimestamp.getTime())
            .toBeGreaterThanOrEqual(results[0].eventTimestamp.getTime());
    });

    it("should handle time projection for events without related facts", async () => {
        const event = await j.fact(new Event("event-5", "Event without cancellation"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
                cancellation: IntegrationTest.TimeProjection.EventCancelled [
                    cancellation->event: IntegrationTest.TimeProjection.Event = event
                ]
            } => {
                event = event,
                eventTimestamp = @event,
                cancellation = cancellation
            }
        `);
        
        const results = await j.query(specification, event);
        
        // Should still return the event even without cancellation
        expect(results).toHaveLength(1);
        expect(results[0].event).toEqual(event);
        expect(results[0].eventTimestamp).toBeInstanceOf(Date);
        expect(results[0].cancellation).toBeUndefined();
    });

    it("should project only timestamp without other data", async () => {
        const event = await j.fact(new Event("event-6", "Timestamp only"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
            } => @event
        `);
        
        const results = await j.query(specification, event);
        
        expect(results).toHaveLength(1);
        expect(results[0]).toBeInstanceOf(Date);
        // Should not include any other properties, just the Date
        expect(typeof results[0].getTime).toBe('function');
    });

    it("should handle multiple time projections in same query", async () => {
        const event1 = await j.fact(new Event("event-7", "First"));
        
        await new Promise(resolve => setTimeout(resolve, 10));
        
        const event2 = await j.fact(new Event("event-8", "Second"));
        
        const specification = parseSpecification(`
            (event: IntegrationTest.TimeProjection.Event) {
            } => {
                identifier = event.identifier,
                timestamp = @event
            }
        `);
        
        const results1 = await j.query(specification, event1);
        const results2 = await j.query(specification, event2);
        
        expect(results1).toHaveLength(1);
        expect(results2).toHaveLength(1);
        
        expect(results1[0].identifier).toBe("event-7");
        expect(results2[0].identifier).toBe("event-8");
        
        expect(results1[0].timestamp).toBeInstanceOf(Date);
        expect(results2[0].timestamp).toBeInstanceOf(Date);
        
        // Verify second event timestamp is not before first
        expect(results2[0].timestamp.getTime())
            .toBeGreaterThanOrEqual(results1[0].timestamp.getTime());
    });
});