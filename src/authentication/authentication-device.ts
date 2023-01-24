import {
    Channel,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    Feed,
    Fork,
    LoginResponse,
    Observable,
    ProjectedResult,
    Query,
    Specification,
    SpecificationListener,
    UserIdentity,
} from "jinaga";

import { Keystore } from "../keystore";
import { Authentication } from "./authentication";

export class AuthenticationDevice implements Authentication {
    constructor(
        private inner: Fork,
        private keystore: Keystore,
        private localDeviceIdentity: UserIdentity
    ) {}

    async close(): Promise<void> {
        await this.inner.close();
        await this.keystore.close();
    }

    async login(): Promise<LoginResponse> {
        throw new Error('No logged in user.');
    }

    async local(): Promise<FactRecord> {
        return await this.keystore.getOrCreateDeviceFact(this.localDeviceIdentity);
    }

    from(fact: FactReference, query: Query): Observable {
        return this.inner.from(fact, query);
    }

    addSpecificationListener(specification: Specification, onResult: (results: ProjectedResult[]) => Promise<void>): SpecificationListener {
        return this.inner.addSpecificationListener(specification, onResult);
    }

    removeSpecificationListener(listener: SpecificationListener): void {
        this.inner.removeSpecificationListener(listener);
    }

    save(envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        return this.inner.save(envelopes);
    }

    query(start: FactReference, query: Query): Promise<FactReference[][]> {
        return this.inner.query(start, query);
    }

    read(start: FactReference[], specification: Specification): Promise<any[]> {
        return this.inner.read(start, specification);
    }

    feed(feed: Feed, bookmark: string): Promise<FactFeed> {
        return this.inner.feed(feed, bookmark);
    }

    whichExist(references: FactReference[]): Promise<FactReference[]> {
        throw new Error("whichExist method not implemented on AuthenticationDevice.");
    }

    load(references: FactReference[]): Promise<FactRecord[]> {
        return this.inner.load(references);
    }

    addChannel(fact: FactReference, query: Query): Channel {
        return this.inner.addChannel(fact, query);
    }

    removeChannel(channel: Channel): void {
        return this.inner.removeChannel(channel);
    }
}