import {
    FactEnvelope,
    FactRecord,
    FactReference,
    Feed,
    Observable,
    ObservableSource,
    Query,
    Specification,
    WebClient,
} from "jinaga";
import { FactFeed } from "jinaga/dist/storage";

export class Principal {
    
}

export class Authentication implements ObservableSource {
    constructor(private inner: ObservableSource, private client: WebClient) {
    }

    async close(): Promise<void> {
        await this.inner.close();
    }

    login() {
        return this.client.login();
    }

    async save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        const saved = await this.inner.save(envelopes);
        return saved;
    }

    query(start: FactReference, query: Query) {
        return this.inner.query(start, query);
    }

    read(start: FactReference[], specification: Specification): Promise<any[]> {
        return this.inner.read(start, specification);
    }

    feed(feed: Feed, bookmark: string, limit: number): Promise<FactFeed> {
        return this.inner.feed(feed, bookmark, limit);
    }

    whichExist(references: FactReference[]): Promise<FactReference[]> {
        throw new Error("whichExist method not implemented on Authentication.");
    }

    load(references: FactReference[]): Promise<FactRecord[]> {
        return this.inner.load(references);
    }

    from(fact: FactReference, query: Query): Observable {
        return this.inner.from(fact, query);
    }
}