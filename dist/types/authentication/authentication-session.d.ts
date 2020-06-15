import { Authentication, FactEnvelope, FactRecord, FactReference, Feed, Keystore, LoginResponse, Observable, Query, UserIdentity } from 'jinaga';
export declare class AuthenticationSession implements Authentication {
    private inner;
    private keystore;
    private userIdentity;
    private displayName;
    private localDeviceIdentity;
    constructor(inner: Feed, keystore: Keystore, userIdentity: UserIdentity, displayName: string, localDeviceIdentity: UserIdentity);
    login(): Promise<LoginResponse>;
    local(): Promise<FactRecord>;
    from(fact: FactReference, query: Query): Observable;
    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]>;
    query(start: FactReference, query: Query): Promise<FactReference[][]>;
    exists(fact: FactReference): Promise<boolean>;
    load(references: FactReference[]): Promise<FactRecord[]>;
}
