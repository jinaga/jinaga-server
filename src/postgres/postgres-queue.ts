import { FactEnvelope, Queue } from "jinaga";
import { Pool } from "pg";
import { ConnectionFactory } from "./connection";

export class PostgresQueue implements Queue {
    private connectionFactory: ConnectionFactory;

    constructor(pool: Pool, private schema: string) {
        this.connectionFactory = new ConnectionFactory(pool);
    }

    peek(): Promise<FactEnvelope[]> {
        throw new Error("Method not implemented.");
    }
    enqueue(envelopes: FactEnvelope[]): Promise<void> {
        throw new Error("Method not implemented.");
    }
    dequeue(envelopes: FactEnvelope[]): Promise<void> {
        throw new Error("Method not implemented.");
    }

}