import { Keystore, UserIdentity } from 'jinaga';
import { FactRecord, FactSignature } from 'jinaga';
export declare class PostgresKeystore implements Keystore {
    private connectionFactory;
    constructor(postgresUri: string);
    getUserFact(userIdentity: UserIdentity): Promise<FactRecord>;
    getDeviceFact(deviceIdentity: UserIdentity): Promise<FactRecord>;
    signFact(userIdentity: UserIdentity, fact: FactRecord): Promise<FactSignature[]>;
    private getIdentityFact;
    private getPublicKey;
    private getPrivateKey;
    private generateKeyPair;
}
