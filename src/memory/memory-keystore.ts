import { computeHash, FactEnvelope, FactRecord, generateKeyPair, KeyPair, PredecessorCollection, UserIdentity } from "jinaga";

import { Keystore } from "../keystore";

export class MemoryKeystore implements Keystore {
    private keyPairs: { [key: string]: KeyPair} = {};

    getOrCreateUserFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return Promise.resolve(this.getOrCreateIdentityFact('Jinaga.User', userIdentity));
    }
    
    getOrCreateDeviceFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return Promise.resolve(this.getOrCreateIdentityFact('Jinaga.Device', userIdentity));
    }

    getUserFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return Promise.resolve(this.getIdentityFact('Jinaga.User', userIdentity));
    }
    
    getDeviceFact(userIdentity: UserIdentity): Promise<FactRecord> {
        return Promise.resolve(this.getIdentityFact('Jinaga.Device', userIdentity));
    }

    signFacts(userIdentity: UserIdentity, facts: FactRecord[]): Promise<FactEnvelope[]> {
        return Promise.resolve(facts.map(fact => {
            return {
                fact,
                signatures: []
            };
        }));
    }

    private getOrCreateIdentityFact(type: string, identity: UserIdentity): FactRecord {
        const publicKey = this.getOrCreatePublicKey(identity);
        const predecessors: PredecessorCollection = {};
        const fields = {
            publicKey: publicKey
        };
        const hash = computeHash(fields, predecessors);
        return { type, hash, predecessors, fields };
    }

    private getIdentityFact(type: string, identity: UserIdentity): FactRecord {
        const publicKey = this.getPublicKey(identity);
        const predecessors: PredecessorCollection = {};
        const fields = {
            publicKey: publicKey
        };
        const hash = computeHash(fields, predecessors);
        return { type, hash, predecessors, fields };
    }

    private getOrCreatePublicKey(userIdentity: UserIdentity): string {
        const key = `${userIdentity.provider}:${userIdentity.id}`;
        const keyPair = this.keyPairs[key];
        if (keyPair) {
            return keyPair.publicPem;
        }
        else {
            return this.generateKeyPair(key);
        }
    }

    private getPublicKey(userIdentity: UserIdentity): string {
        const key = `${userIdentity.provider}:${userIdentity.id}`;
        const keyPair = this.keyPairs[key];
        if (keyPair) {
            return keyPair.publicPem;
        }
        else {
            throw new Error("Public key not found");
        }
    }

    private generateKeyPair(key: string) {
        const keyPair = generateKeyPair();
        this.keyPairs[key] = keyPair;
        return keyPair.privatePem;
    }
}