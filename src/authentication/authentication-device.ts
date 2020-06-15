import { Feed, Observable } from 'jinaga';
import { LoginResponse } from 'jinaga';
import { Keystore, UserIdentity } from 'jinaga';
import { Query } from 'jinaga';
import { FactEnvelope, FactRecord, FactReference } from 'jinaga';
import { Authentication } from 'jinaga';

export class AuthenticationDevice implements Authentication {
    constructor(
        private inner: Feed,
        private keystore: Keystore,
        private localDeviceIdentity: UserIdentity
    ) {}

    async login(): Promise<LoginResponse> {
        throw new Error('No logged in user.');
    }

    async local(): Promise<FactRecord> {
        return await this.keystore.getDeviceFact(this.localDeviceIdentity);
    }

    from(fact: FactReference, query: Query): Observable {
        return this.inner.from(fact, query);
    }

    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        return this.inner.save(envelopes);
    }

    query(start: FactReference, query: Query): Promise<FactReference[][]> {
        return this.inner.query(start, query);
    }

    exists(fact: FactReference): Promise<boolean> {
        throw new Error("Exists method not implemented on AuthenticationDevice.");
    }

    load(references: FactReference[]): Promise<FactRecord[]> {
        return this.inner.load(references);
    }
}