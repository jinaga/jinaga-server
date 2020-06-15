import { Feed, Observable } from 'jinaga';
import { LoginResponse } from 'jinaga';
import { Keystore, UserIdentity } from 'jinaga';
import { Query } from 'jinaga';
import { FactEnvelope, FactRecord, FactReference } from 'jinaga';
import { Authentication } from 'jinaga';
export declare class AuthenticationDevice implements Authentication {
    private inner;
    private keystore;
    private localDeviceIdentity;
    constructor(inner: Feed, keystore: Keystore, localDeviceIdentity: UserIdentity);
    login(): Promise<LoginResponse>;
    local(): Promise<FactRecord>;
    from(fact: FactReference, query: Query): Observable;
    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]>;
    query(start: FactReference, query: Query): Promise<FactReference[][]>;
    exists(fact: FactReference): Promise<boolean>;
    load(references: FactReference[]): Promise<FactRecord[]>;
}
