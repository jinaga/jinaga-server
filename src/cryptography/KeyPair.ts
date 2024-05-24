import { pki } from "node-forge";

export interface KeyPair {
    publicPem: string;
    privatePem: string;
}

export function generateKeyPair(): KeyPair {
    const keypair = pki.rsa.generateKeyPair({ bits: 2048 });
    const privatePem = pki.privateKeyToPem(keypair.privateKey);
    const publicPem = pki.publicKeyToPem(keypair.publicKey);
    return { privatePem, publicPem };
}
