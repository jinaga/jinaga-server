import { FactReference, factReferenceEquals } from "jinaga";

interface Batch {
  factReferences: FactReference[];
  userReference: FactReference | null;
  createdAt: Date;
}

export class DistributedFactCache {
  private batches: Batch[] = [];

  add(factReferences: FactReference[], userReference: FactReference | null): void {
    this.removeOldBatches();
    this.batches.push({
      factReferences,
      userReference,
      createdAt: new Date()
    });
  }

  includesAll(references: FactReference[], userFact: FactReference | null): boolean {
    this.removeOldBatches();
    return references.every(reference =>
      this.batches.some(batch =>
        batch.factReferences.some(factReferenceEquals(reference)) &&
        (batch.userReference === null || batch.userReference === userFact)));
  }

  removeOldBatches() {
    const cutoff = new Date().getTime() - 1000 * 60 * 5;
    this.batches = this.batches.filter(batch =>
      batch.createdAt.getTime() > cutoff);
  }
}