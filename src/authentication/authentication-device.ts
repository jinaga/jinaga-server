import { Authentication, AuthorizationEngine, AuthorizationRules, FactEnvelope, FactRecord, LoginResponse, Storage, UserIdentity } from "jinaga";

import { Keystore } from "../keystore";

export class AuthenticationDevice implements Authentication {
    private authorizationEngine: AuthorizationEngine | null;

    constructor(
        private store: Storage,
        private keystore: Keystore,
        authorizationRules: AuthorizationRules | null,
        private localDeviceIdentity: UserIdentity
    ) {
        this.authorizationEngine = authorizationRules &&
            new AuthorizationEngine(authorizationRules, store);
    }

    async login(): Promise<LoginResponse> {
        throw new Error('No logged in user.');
    }

    async local(): Promise<FactRecord> {
        const deviceFact = await this.keystore.getOrCreateDeviceFact(this.localDeviceIdentity);
        const envelopes = [
            <FactEnvelope>{
                fact: deviceFact,
                signatures: []
            }
        ];
        await this.store.save(envelopes);
        return deviceFact;
    }

    async authorize(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        const deviceFact = await this.keystore.getOrCreateDeviceFact(this.localDeviceIdentity);
        const facts = envelopes.map(envelope => envelope.fact);
        const authorizedFacts = this.authorizationEngine
            ? await this.authorizationEngine.authorizeFacts(facts, deviceFact)
            : facts;
        const signedFacts = await this.keystore.signFacts(this.localDeviceIdentity, authorizedFacts);
        return signedFacts;
    }
}