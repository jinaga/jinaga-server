import { Channel, FactEnvelope, FactFeed, FactPath, FactRecord, FactReference, Feed, Fork, LoginResponse, Observable, ObservableSource, ProjectedResult, Query, Specification, SpecificationListener } from "jinaga";
import { Authentication } from "./authentication";

export class AuthenticationNoOp implements Authentication {

    constructor(
        private inner: ObservableSource
    ) { }

    login(): Promise<LoginResponse> {
        throw new Error("No keystore is configured.");
    }

    local(): Promise<FactRecord> {
        throw new Error("No keystore is configured.");
    }

    addChannel(fact: FactReference, query: Query): Channel {
        throw new Error("No keystore is configured.");
    }

    removeChannel(channel: Channel): void {
        throw new Error("No keystore is configured.");
    }

    from(fact: FactReference, query: Query): Observable {
        return this.inner.from(fact, query);
    }

    addSpecificationListener(specification: Specification, onResult: (results: ProjectedResult[]) => Promise<void>): SpecificationListener {
        return this.inner.addSpecificationListener(specification, onResult);
    }

    removeSpecificationListener(listener: SpecificationListener): void {
        return this.inner.removeSpecificationListener(listener);
    }

    close(): Promise<void> {
        return this.inner.close();
    }

    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        return this.inner.save(envelopes);
    }

    query(start: FactReference, query: Query): Promise<FactPath[]> {
        return this.inner.query(start, query);
    }

    read(start: FactReference[], specification: Specification): Promise<ProjectedResult[]> {
        return this.inner.read(start, specification);
    }

    feed(feed: Feed, bookmark: string): Promise<FactFeed> {
        return this.inner.feed(feed, bookmark);
    }

    whichExist(references: FactReference[]): Promise<FactReference[]> {
        return this.inner.whichExist(references);
    }

    load(references: FactReference[]): Promise<FactRecord[]> {
        return this.inner.load(references);
    }
}