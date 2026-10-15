import { Trace, Tracer } from "jinaga";
import { Pool } from "pg";

import { JinagaServer } from "../../src/jinaga-server";

jest.mock("pg", () => {
    const actual = jest.requireActual("pg");
    const createdPools: any[] = [];
    class CapturingPool extends actual.Pool {
        constructor(options: any) {
            super(options);
            createdPools.push(this);
        }
    }
    return Object.assign({}, actual, { Pool: CapturingPool, createdPools });
});

const { createdPools } = jest.requireMock("pg") as { createdPools: Pool[] };

const connectionString = "postgresql://appuser:apppw@localhost:5432/appdb";

const poolVariables = [
    "POSTGRES_POOL_MAX",
    "POSTGRES_IDLE_TIMEOUT_MILLIS",
    "POSTGRES_CONNECTION_TIMEOUT_MILLIS"
];

class CapturingTracer implements Tracer {
    public readonly infoMessages: string[] = [];

    info(message: string): void {
        this.infoMessages.push(message);
    }
    warn(message: string): void { }
    error(error: any): void { }
    dependency<T>(name: string, data: string, operation: () => Promise<T>): Promise<T> {
        return operation();
    }
    metric(message: string, measurements: { [key: string]: number; }): void { }
    counter(name: string, value: number): void { }
}

describe("Postgres pool configuration", () => {
    const savedVariables: { [name: string]: string | undefined } = {};
    let previousTracer: Tracer;
    let tracer: CapturingTracer;

    beforeEach(() => {
        for (const name of poolVariables) {
            savedVariables[name] = process.env[name];
            delete process.env[name];
        }
        createdPools.length = 0;
        previousTracer = Trace.getTracer();
        tracer = new CapturingTracer();
        Trace.configure(tracer);
    });

    afterEach(() => {
        for (const name of poolVariables) {
            const saved = savedVariables[name];
            if (saved === undefined) {
                delete process.env[name];
            }
            else {
                process.env[name] = saved;
            }
        }
        Trace.configure(previousTracer);
    });

    // Reads the options of the pool that create built. It never opens a
    // connection, because pg defers connecting until a client is checked out.
    function optionsOfPoolBuiltFromConnectionString(): any {
        JinagaServer.create({ pgStore: connectionString });
        expect(createdPools).toHaveLength(1);
        return (createdPools[0] as any).options;
    }

    it("defaults to ten connections, a thirty second idle timeout, and no checkout timeout", () => {
        const options = optionsOfPoolBuiltFromConnectionString();

        expect(options.max).toBe(10);
        expect(options.idleTimeoutMillis).toBe(30000);
        expect(options.connectionTimeoutMillis).toBe(0);
    });

    it("takes the pool size from POSTGRES_POOL_MAX", () => {
        process.env.POSTGRES_POOL_MAX = "40";

        expect(optionsOfPoolBuiltFromConnectionString().max).toBe(40);
    });

    it("takes the checkout timeout from POSTGRES_CONNECTION_TIMEOUT_MILLIS", () => {
        process.env.POSTGRES_CONNECTION_TIMEOUT_MILLIS = "5000";

        expect(optionsOfPoolBuiltFromConnectionString().connectionTimeoutMillis).toBe(5000);
    });

    it("takes the idle timeout from POSTGRES_IDLE_TIMEOUT_MILLIS", () => {
        process.env.POSTGRES_IDLE_TIMEOUT_MILLIS = "60000";

        expect(optionsOfPoolBuiltFromConnectionString().idleTimeoutMillis).toBe(60000);
    });

    it.each(poolVariables)("refuses a value of %s that is not a non-negative integer", (name) => {
        process.env[name] = "30s";

        expect(() => JinagaServer.create({ pgStore: connectionString }))
            .toThrow(/POSTGRES_[A-Z_]+.*30s|30s.*POSTGRES_[A-Z_]+/);
        expect(() => JinagaServer.create({ pgStore: connectionString }))
            .toThrow(new RegExp(name));
    });

    it("refuses a pool of zero connections", () => {
        process.env.POSTGRES_POOL_MAX = "0";

        expect(() => JinagaServer.create({ pgStore: connectionString }))
            .toThrow(/POSTGRES_POOL_MAX/);
    });

    it("traces the resolved settings of each pool it builds from a connection string", () => {
        process.env.POSTGRES_POOL_MAX = "40";
        process.env.POSTGRES_IDLE_TIMEOUT_MILLIS = "60000";
        process.env.POSTGRES_CONNECTION_TIMEOUT_MILLIS = "5000";

        JinagaServer.create({ pgStore: connectionString });

        const poolMessages = tracer.infoMessages.filter(m => /pool/i.test(m));
        expect(poolMessages).toHaveLength(1);
        expect(poolMessages[0]).toContain("40");
        expect(poolMessages[0]).toContain("60000");
        expect(poolMessages[0]).toContain("5000");
        expect(poolMessages[0]).not.toContain("apppw");
    });

    it("uses a pool the caller supplies exactly as given", () => {
        process.env.POSTGRES_POOL_MAX = "40";
        const actualPg = jest.requireActual("pg");
        const suppliedPool = new actualPg.Pool({ connectionString, max: 3 });

        JinagaServer.create({ pgStore: suppliedPool });

        expect(createdPools).toHaveLength(0);
        expect(suppliedPool.options.max).toBe(3);
    });
});
