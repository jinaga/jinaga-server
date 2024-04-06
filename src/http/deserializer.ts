import { FactEnvelope, FactRecord, FactReference, FactSignature, PredecessorCollection, computeHash } from "jinaga";

export interface GraphSource {
    read(
        onEnvelopes: (envelopes: FactEnvelope[]) => Promise<void>
    ): Promise<void>;
}

export class GraphDeserializer implements GraphSource {
    private factReferences: FactReference[] = [];
    private publicKeys: string[] = [];

    constructor(
        private readonly readLine: () => Promise<string | null>
    ) {}

    async read(
        onEnvelopes: (envelopes: FactEnvelope[]) => Promise<void>
    ) {
        let envelopes: FactEnvelope[] = [];
        let line: string | null;
        while ((line = await this.readLine()) !== null) {
            // Read the fact
            const type = JSON.parse(line);
            const predecessorIndexes = await this.parseNextJSONLine();
            const fields = await this.parseNextJSONLine();

            const predecessors = this.getPredecessorReferences(predecessorIndexes);

            const hash = computeHash(fields, predecessors);
            this.factReferences.push({ type, hash });
            const fact: FactRecord = { type, hash, predecessors, fields };

            const signatures = await this.readSignatures();

            envelopes.push({ fact, signatures });

            // Periodically handle a batch of envelopes
            if (envelopes.length >= 20) {
                await onEnvelopes(envelopes);
                envelopes = [];
            }
        }
        if (envelopes.length > 0) {
            await onEnvelopes(envelopes);
        }
    }

    private getPredecessorReferences(predecessorIndexes: any) {
        const predecessors: PredecessorCollection = {};
        for (const role in predecessorIndexes) {
            const index = predecessorIndexes[role];
            if (Array.isArray(index)) {
                predecessors[role] = index.map(i => {
                    if (i >= this.factReferences.length) {
                        throw new Error(`Predecessor reference ${i} is out of range`);
                    }
                    return this.factReferences[i];
                });
            } else {
                if (index >= this.factReferences.length) {
                    throw new Error(`Predecessor reference ${index} is out of range`);
                }
                predecessors[role] = this.factReferences[index];
            }
        }
        return predecessors;
    }

    private async readSignatures(): Promise<FactSignature[]> {
        const signatures: FactSignature[] = [];
        let line: string | null;
        while ((line = await this.readLine()) !== null && line !== "") {
            if (!line.startsWith("PK")) {
                throw new Error(`Expected public key reference, but got "${line}"`);
            }
            const publicKeyIndex = parseInt(line.substring(2));
            if (publicKeyIndex >= this.publicKeys.length) {
                throw new Error(`Public key reference ${publicKeyIndex} is out of range`);
            }
            const publicKey = this.publicKeys[publicKeyIndex];
            const signature = await this.parseNextJSONLine();

            signatures.push({ publicKey, signature });
        }
        return signatures;
    }

    private async parseNextJSONLine() {
        const line = await this.readLine();
        if (!line) {
            throw new Error("Expected JSON line, but got end of file");
        }
        return JSON.parse(line);
    }
}