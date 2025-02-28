import { Trace } from 'jinaga';
import { DatabaseError, Pool, PoolClient } from 'pg';
import { delay } from "../util/promise";

export type Row = { [key: string]: any };

export class ConnectionFactory {
    constructor (private postgresPool: Pool) {
    }

    withTransaction<T>(callback: (connection: PoolClient) => Promise<T>) {
        return this.with(async connection => {
            while (true) {
                try {
                    await connection.query('BEGIN');
                    const result = await callback(connection);
                    await connection.query('COMMIT');
                    return result;
                }
                catch (e) {
                    await connection.query('ROLLBACK');
                    throw e;
                }
            }
        });
    }

    async with<T>(callback: (connection: PoolClient) => Promise<T>) : Promise<T> {
        let attempt = 0;
        const maxAttempts = 4;
        const baseDelay = 10;
        while (attempt < maxAttempts) {
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
                if (attempt === maxAttempts) {
                    Trace.error("Postgres error after max attempts: " + describeError(e));
                    throw e;
                }
            }
            const delayTime = baseDelay * Math.pow(2, attempt-1);
            Trace.warn("Attempt number " + attempt + ". Postgres retrying in " + delayTime + "ms");
            await delay(delayTime);
        }
        throw new Error("Number of attempts exceeded");
    }

    private createClient() {
        return this.postgresPool.connect();
    }
}

function isTransientError(e: any) {
    if (e.code === 'ECONNREFUSED' || e.code === '23505') { // 23505 is the code for unique_violation
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
