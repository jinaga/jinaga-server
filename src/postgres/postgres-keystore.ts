import { computeHash, FactEnvelope, FactRecord, PredecessorCollection, UserIdentity } from "jinaga";
import { Pool, PoolClient } from "pg";

import { generateKeyPair, KeyPair } from "../cryptography/KeyPair";
import { signFacts } from "../cryptography/signFacts";
import { Keystore } from "../keystore";
import { ConnectionFactory } from "./connection";

export class PostgresKeystore implements Keystore {
    private connectionFactory: ConnectionFactory;
    private cache: Map<string, KeyPair> = new Map();

    constructor (pool: Pool, private schema: string) {
        this.connectionFactory = new ConnectionFactory(pool);
    }

    getOrCreateUserFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return this.getOrCreateIdentityFact('Jinaga.User', userIdentity);
    }

    getOrCreateDeviceFact(deviceIdentity: UserIdentity): Promise<FactRecord> {
        return this.getOrCreateIdentityFact('Jinaga.Device', deviceIdentity);
    }

    getUserFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return this.getIdentityFact('Jinaga.User', userIdentity);
    }

    getDeviceFact(deviceIdentity: UserIdentity): Promise<FactRecord> {
        return this.getIdentityFact('Jinaga.Device', deviceIdentity);
    }

    async signFacts(userIdentity: UserIdentity, facts: FactRecord[]): Promise<FactEnvelope[]> {
        if (!userIdentity) {
            return facts.map(fact => ({ fact, signatures: [] }));
        }
        
        const keyPair = await this.getKeyPair(userIdentity);
        return signFacts(keyPair, facts);
    }

    private async getOrCreateIdentityFact(type: string, identity: UserIdentity): Promise<FactRecord> {
        const { publicPem } = await this.getOrGenerateKeyPair(identity);
        const predecessors: PredecessorCollection = {};
        const fields = {
            publicKey: publicPem
        };
        const hash = computeHash(fields, predecessors);
        return { type, hash, predecessors, fields };
    }

    private async getIdentityFact(type: string, identity: UserIdentity): Promise<FactRecord> {
        const { publicPem } = await this.getKeyPair(identity);
        const predecessors: PredecessorCollection = {};
        const fields = {
            publicKey: publicPem
        };
        const hash = computeHash(fields, predecessors);
        return { type, hash, predecessors, fields };
    }

    private async getKeyPair(userIdentity: UserIdentity): Promise<KeyPair> {
        const key = getUserIdentityKey(userIdentity);
        if (this.cache.has(key)) {
            return this.cache.get(key)!;
        }
        const keyPair = await this.connectionFactory.with(connection =>
            this.selectKeyPair(connection, userIdentity));
        this.cache.set(key, keyPair);
        return keyPair;
    }

    private async selectKeyPair(connection: PoolClient, userIdentity: UserIdentity): Promise<KeyPair> {
        const { rows } = await connection.query(`SELECT public_key, private_key FROM ${this.schema}.user WHERE provider = $1 AND user_identifier = $2`,
            [userIdentity.provider, userIdentity.id]);
        if (rows.length > 1) {
            throw new Error('Duplicate entries found in the keystore');
        }
        else if (rows.length === 1) {
            const publicPem = <string>rows[0]["public_key"];
            const privatePem = rows[0]["private_key"];
            return { publicPem, privatePem };
        }
        else {
            throw new Error('No entry found in the keystore');
        }
    }

    private async getOrGenerateKeyPair(userIdentity: UserIdentity): Promise<KeyPair> {
        const key = getUserIdentityKey(userIdentity);
        if (this.cache.has(key)) {
            return this.cache.get(key)!;
        }
        const keyPair = await this.connectionFactory.withTransaction(connection =>
            this.selectOrInsertKeyPair(connection, userIdentity));
        this.cache.set(key, keyPair);
        return keyPair;
    }

    private async selectOrInsertKeyPair(connection: PoolClient, userIdentity: UserIdentity): Promise<KeyPair> {
        const { rows } = await connection.query(`SELECT public_key, private_key FROM ${this.schema}.user WHERE provider = $1 AND user_identifier = $2`,
            [userIdentity.provider, userIdentity.id]);
        if (rows.length > 1) {
            throw new Error('Duplicate entries found in the keystore');
        }
        else if (rows.length === 1) {
            const publicPem: string = rows[0]["public_key"];
            const privatePem: string = rows[0]["private_key"];
            return { publicPem, privatePem };
        }
        else {
            const keyPair = await this.generateKeyPair(connection, userIdentity);
            return keyPair;
        }
    }

    private async generateKeyPair(connection: PoolClient, userIdentity: UserIdentity): Promise<KeyPair> {
        const keyPair = generateKeyPair();
        await connection.query(`INSERT INTO ${this.schema}.user (provider, user_identifier, private_key, public_key) VALUES ($1, $2, $3, $4)`,
            [userIdentity.provider, userIdentity.id, keyPair.privatePem, keyPair.publicPem]);
        return keyPair;
    }
}

function getUserIdentityKey(userIdentity: UserIdentity) {
    return `${userIdentity.provider}-${userIdentity.id}`;
}
