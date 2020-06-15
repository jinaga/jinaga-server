import { PoolClient } from 'pg';
export declare type Row = {
    [key: string]: any;
};
export declare class ConnectionFactory {
    private postgresPool;
    constructor(postgresUri: string);
    withTransaction<T>(callback: (connection: PoolClient) => Promise<T>): Promise<T>;
    with<T>(callback: (connection: PoolClient) => Promise<T>): Promise<T>;
    private createClient;
}
