import { Authentication, AuthorizationEngine, AuthorizationRules, FactEnvelope, FactRecord, LoginResponse, Storage, UserIdentity } from "jinaga";

import { Keystore } from "../keystore";

export class AuthenticationSession implements Authentication {
    private authorizationEngine: AuthorizationEngine | null;

    constructor(
        private inner: Storage,
        private keystore: Keystore,
        authorizationRules: AuthorizationRules | null,
        private userIdentity: UserIdentity,
        private displayName: string,
        private localDeviceIdentity: UserIdentity
    ) {
        this.authorizationEngine = authorizationRules &&
            new AuthorizationEngine(authorizationRules, inner);
    }
    
    async login(): Promise<LoginResponse> {
        const userFact = await this.keystore.getOrCreateUserFact(this.userIdentity);
        const signedFacts = await this.keystore.signFacts(this.userIdentity, [userFact]);
        await this.inner.save(signedFacts);
        return {
            userFact,
            profile: {
                displayName: this.displayName
            }
        };
    }

    async local(): Promise<FactRecord> {
        const deviceFact = await this.keystore.getOrCreateDeviceFact(this.localDeviceIdentity);
        const signedFact: FactEnvelope = {
            fact: deviceFact,
            signatures: []
        };
        await this.inner.save([signedFact]);
        return deviceFact;
    }

    async authorize(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        const userFact = await this.keystore.getUserFact(this.userIdentity);
        const facts = envelopes.map(envelope => envelope.fact);
        const authorizedFacts = this.authorizationEngine
            ? await this.authorizationEngine.authorizeFacts(facts, userFact)
            : facts;
        const signedFacts = await this.keystore.signFacts(this.userIdentity, authorizedFacts);
        return signedFacts;
    }
}