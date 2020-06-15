import { Query } from 'jinaga';
import { FactEnvelope, FactPath, FactRecord, FactReference, Storage } from 'jinaga';
export declare class PostgresStore implements Storage {
    private connectionFactory;
    constructor(postgresUri: string);
    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]>;
    query(start: FactReference, query: Query): Promise<FactPath[]>;
    exists(fact: FactReference): Promise<boolean>;
    load(references: FactReference[]): Promise<FactRecord[]>;
}
