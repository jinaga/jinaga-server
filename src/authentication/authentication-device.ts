import { Authentication, AuthorizationEngine, AuthorizationRules, FactEnvelope, FactRecord, LoginResponse, Storage, UserIdentity, factReferenceEquals } from "jinaga";

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

        if (this.authorizationEngine) {
            const results = await this.authorizationEngine.authorizeFacts(envelopes, deviceFact);
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