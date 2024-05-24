import { canonicalizeFact, FactEnvelope, FactRecord, Trace } from "jinaga";
import { md, pki, util } from "node-forge";
import { KeyPair } from "./KeyPair";

export function signFacts(keyPair: KeyPair, facts: FactRecord[]) {
    const privateKey = <pki.rsa.PrivateKey>pki.privateKeyFromPem(keyPair.privatePem);
    const envelopes: FactEnvelope[] = facts.map(fact => signFact(fact, keyPair.publicPem, privateKey));
    return envelopes;
}
function signFact(fact: FactRecord, publicPem: string, privateKey: pki.rsa.PrivateKey): FactEnvelope {
    const canonicalString = canonicalizeFact(fact.fields, fact.predecessors);
    const encodedString = util.encodeUtf8(canonicalString);
    const digest = md.sha512.create().update(encodedString);
    const hash = util.encode64(digest.digest().getBytes());
    if (fact.hash !== hash) {
        Trace.error(`Hash does not match. "${fact.hash}" !== "${hash}"\nFact: ${canonicalString}`);
        return {
            fact,
            signatures: []
        };
    }
    const signature = util.encode64(privateKey.sign(digest));
    return {
        fact,
        signatures: [{
            signature,
            publicKey: publicPem
        }]
    };
}
