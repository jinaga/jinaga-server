import { FactEnvelope, FactReference, PredecessorCollection } from "jinaga";

type IndexPredecessorCollection = {
    [role: string]: number | number[];
};

export class GraphSerializer
{
    private index = 0;
    private indexByFactReference: { [key: string]: number } = {};
    private publicKeys: string[] = [];

    constructor(
        private readonly write: (chunk: string) => void
    ) {}

    serialize(result: FactEnvelope[]) {
        // Write the current index
        this.write(`---\n${this.index.toString()}\n\n`);

        // Write the facts
        for (const fact of result) {
            // Write any new public keys
            for (const signature of fact.signatures) {
                if (!this.publicKeys.includes(signature.publicKey)) {
                    const pkIndex = this.publicKeys.length;
                    const publicKey = JSON.stringify(signature.publicKey);
                    this.write(`PK${pkIndex.toString()}\n${publicKey}\n\n`);
                    this.publicKeys.push(signature.publicKey);
                }
            }

            // Write the fact
            const factType = JSON.stringify(fact.fact.type);
            const predecessorIndexes = JSON.stringify(this.getPredecessorIndexes(fact.fact.predecessors));
            const factFields = JSON.stringify(fact.fact.fields);

            this.write(`${factType}\n${predecessorIndexes}\n${factFields}`);

            // Write the signatures
            for (const signature of fact.signatures) {
                const publicKeyIndex = this.publicKeys.indexOf(signature.publicKey);
                const publicKey = `PK${publicKeyIndex.toString()}`;
                const signatureString = JSON.stringify(signature.signature);

                this.write(`\n${publicKey}\n${signatureString}`);
            }

            this.write("\n\n");

            const key = fact.fact.type + ":" + fact.fact.hash;
            this.indexByFactReference[key] = this.index;
            this.index++;
        }
    }

    private getPredecessorIndexes(predecessors: PredecessorCollection): IndexPredecessorCollection {
        const result: IndexPredecessorCollection = {};
        for (const role in predecessors) {
            const reference = predecessors[role];
            if (Array.isArray(reference)) {
                result[role] = reference.map(r => this.getFactIndex(r));
            } else {
                result[role] = this.getFactIndex(reference);
            }
        }
        return result;
    }

    private getFactIndex(reference: FactReference): number {
        const key = reference.type + ":" + reference.hash;
        return this.indexByFactReference[key];
    }
}