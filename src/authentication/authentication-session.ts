import { Authentication, FactEnvelope, FactRecord, FactReference, Feed, Keystore, LoginResponse, Observable, Query, UserIdentity } from 'jinaga';

export class AuthenticationSession implements Authentication {
    constructor(
        private inner: Feed,
        private keystore: Keystore,
        private userIdentity: UserIdentity,
        private displayName: string,
        private localDeviceIdentity: UserIdentity
    ) {}

    async login(): Promise<LoginResponse> {
        const userFact = await this.keystore.getUserFact(this.userIdentity);
        return {
            userFact,
            profile: {
                displayName: this.displayName
            }
        };
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
        throw new Error("Exists method not implemented on AuthenticationSession.");
    }

    load(references: FactReference[]): Promise<FactRecord[]> {
        return this.inner.load(references);
    }
}