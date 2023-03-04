import { FactEnvelope, FactRecord, UserIdentity } from "jinaga";

export interface Keystore {
    getOrCreateUserFact(userIdentity: UserIdentity): Promise<FactRecord>;
    getOrCreateDeviceFact(userIdentity: UserIdentity): Promise<FactRecord>;
    getUserFact(userIdentity: UserIdentity): Promise<FactRecord>;
    getDeviceFact(userIdentity: UserIdentity): Promise<FactRecord>;
    signFacts(userIdentity: UserIdentity, facts: FactRecord[]): Promise<FactEnvelope[]>;
}