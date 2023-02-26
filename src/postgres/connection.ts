import { DatabaseError, Pool, PoolClient } from 'pg';
import { delay } from "../util/promise";

export type Row = { [key: string]: any };

export class ConnectionFactory {
    private postgresPool: Pool;

    constructor (postgresUri: string) {
        this.postgresPool = new Pool({
            connectionString: postgresUri
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
                    await connection.query('ROLLBACK');
                    if (e instanceof DatabaseError && e.code === '23505') {
                        attempts--;
                        if (attempts === 0) {
                            throw e;
                        }
                    }
                    else {
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
                    throw e;
                }
                attempt++;
                if (attempt === pause.length) {
                    throw e;
                }
            }
            if (pause[attempt] > 0) {
                await delay(pause[attempt]);
            }
        }
        throw new Error("Number of attempts exceeded");
    }

    private async createClient() {
        return await this.postgresPool.connect();
    }
}

function isTransientError(e: any) {
    if (e.code === 'ECONNREFUSED') {
        return true;
    }
    console.error("Postgres error:", e);
    return false;
}
