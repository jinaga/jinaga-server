import { FactEnvelope, Queue } from "jinaga";
import { Pool } from "pg";
import { ConnectionFactory } from "./connection";

export class PostgresQueue implements Queue {
    private connectionFactory: ConnectionFactory;

    constructor(pool: Pool, private schema: string) {
        this.connectionFactory = new ConnectionFactory(pool, false);
    }

    peek(): Promise<FactEnvelope[]> {
        // Not yet implemented
        return Promise.resolve([]);
    }

    enqueue(envelopes: FactEnvelope[]): Promise<void> {
        // Not yet implemented
        return Promise.resolve();
    }

    dequeue(envelopes: FactEnvelope[]): Promise<void> {
        // Not yet implemented
        return Promise.resolve();
    }

}