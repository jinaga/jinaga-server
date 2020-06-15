import { Feed } from 'jinaga';
import { Keystore, UserIdentity } from 'jinaga';
import { Query } from 'jinaga';
import { FactRecord, FactReference } from 'jinaga';
import { Authorization } from 'jinaga';
import { AuthorizationRules } from 'jinaga';
export declare class AuthorizationKeystore implements Authorization {
    private feed;
    private keystore;
    private authorizationEngine;
    constructor(feed: Feed, keystore: Keystore, authorizationRules: AuthorizationRules | null);
    getUserFact(userIdentity: UserIdentity): Promise<FactRecord>;
    query(userIdentity: UserIdentity, start: FactReference, query: Query): Promise<import("jinaga").FactPath[]>;
    load(userIdentity: UserIdentity, references: FactReference[]): Promise<FactRecord[]>;
    save(userIdentity: UserIdentity, facts: FactRecord[]): Promise<FactRecord[]>;
}
