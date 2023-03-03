import { Trace } from 'jinaga';
import { DatabaseError, Pool, PoolClient } from 'pg';
import { delay } from "../util/promise";

export type Row = { [key: string]: any };

export class ConnectionFactory {
    private postgresPool: Pool;
    private server: string;

    constructor (postgresUri: string) {
        this.postgresPool = new Pool({
            connectionString: postgresUri
        });

        // Parse the Postgres URI to find the host name.
        if (postgresUri.startsWith('postgres://')) {
            const host = postgresUri.split('@')[1].split(':')[0];
            this.server = host;
        }
        else {
            this.server = 'localhost';
        }

        this.postgresPool.on('error', (err, client) => {
            Trace.error(err);
        });
    }

    async close() {
        await this.postgresPool.end();
    }

    withTransaction<T>(callback: (connection: PoolClient) => Promise<T>) {
        return this.with(async connection => {
            // If the insert throws a duplicate key error, then retry the select.
            let attempts = 2;
            while (true) {
                try {
                    await connection.query('BEGIN');
                    const result = await callback(connection);
                    await connection.query('COMMIT');
                    return result;
                }
                catch (e) {
                    Trace.warn("Postgres transaction error: " + describeError(e));
                    await connection.query('ROLLBACK');
                    if (e instanceof DatabaseError && e.code === '23505') {
                        Trace.warn("Postgres duplicate key: retrying");
                        attempts--;
                        if (attempts === 0) {
                            throw e;
                        }
                    }
                    else {
                        Trace.error(e);
                        throw e;
                    }
                }
            }
        })
    }

    async with<T>(callback: (connection: PoolClient) => Promise<T>) : Promise<T> {
        let attempt = 0;
        const pause = [0, 0, 1000, 5000, 15000, 30000];
        while (attempt < pause.length) {
            try {
                const client = await this.createClient();
                try {
                    return await callback(client);
                }
                finally {
                    client.release();
                }
            }
            catch (e) {
                if (!isTransientError(e)) {
                    Trace.error(e);
                    throw e;
                }
                Trace.warn("Postgres transient error: " + describeError(e));
                attempt++;
                if (attempt === pause.length) {
                    throw e;
                }
            }
            if (pause[attempt] > 0) {
                Trace.warn("Postgres retrying in " + pause[attempt] + "ms");
                await delay(pause[attempt]);
            }
        }
        throw new Error("Number of attempts exceeded");
    }

    private createClient() {
        return Trace.dependency('Postgres client', this.server, () => {
            return this.postgresPool.connect();
        });
    }
}

function isTransientError(e: any) {
    if (e.code === 'ECONNREFUSED') {
        return true;
    }
    return false;
}

function describeError(e: any) {
    const error = {
        code: e.code,
        message: e.message,
    };
    return JSON.stringify(error);
}
