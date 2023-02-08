import { Authentication, FactEnvelope, FactRecord, LoginResponse, UserIdentity } from "jinaga";

import { Keystore } from "../keystore";

export class AuthenticationDevice implements Authentication {
    constructor(
        private keystore: Keystore,
        private localDeviceIdentity: UserIdentity
    ) {}

    async login(): Promise<LoginResponse> {
        throw new Error('No logged in user.');
    }

    async local(): Promise<FactRecord> {
        return await this.keystore.getOrCreateDeviceFact(this.localDeviceIdentity);
    }

    authorize(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        throw new Error('No logged in user.');
    }
}