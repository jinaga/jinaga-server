import { Authentication, AuthorizationEngine, AuthorizationRules, FactEnvelope, FactRecord, LoginResponse, Storage, UserIdentity, factReferenceEquals } from "jinaga";

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

        if (this.authorizationEngine) {
            const results = await this.authorizationEngine.authorizeFactsNew(envelopes, userFact);
            const authorizedEnvelopes: FactEnvelope[] = results.map(r => {
                const isFact = factReferenceEquals(r.fact);
                const envelope = envelopes.find(e => isFact(e.fact));
                if (!envelope) {
                    throw new Error("Fact not found in envelopes.");
                }
                if (r.verdict === "Accept") {
                    return {
                        fact: r.fact,
                        signatures: envelope.signatures
                            .filter(s => r.newPublicKeys.includes(s.publicKey))
                    };
                }
                else if (r.verdict === "Existing") {
                    return envelope;
                }
                else {
                    throw new Error("Unexpected verdict.");
                }
            });
            return authorizedEnvelopes;
        }
        else {
            return envelopes;
        }
    }
}