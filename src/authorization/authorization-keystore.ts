import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    FactEnvelope,
    FactRecord,
    FactReference,
    Feed,
    ObservableSource,
    Query,
    Specification,
    UserIdentity,
} from "jinaga";
import { FactFeed } from "jinaga/dist/storage";

import { Keystore } from "../keystore";

export class AuthorizationKeystore implements Authorization {
    private authorizationEngine: AuthorizationEngine | null;

    constructor(
        private observableSource: ObservableSource,
        private keystore: Keystore,
        authorizationRules: AuthorizationRules | null) {

        this.authorizationEngine = authorizationRules &&
            new AuthorizationEngine(authorizationRules, observableSource);
    }

    async getOrCreateUserFact(userIdentity: UserIdentity) {
        const userFact = await this.keystore.getOrCreateUserFact(userIdentity);
        const envelopes = [
            <FactEnvelope>{
                fact: userFact,
                signatures: []
            }
        ];
        await this.observableSource.save(envelopes);
        return userFact;
    }

    query(userIdentity: UserIdentity, start: FactReference, query: Query) {
        return this.observableSource.query(start, query);
    }

    read(userIdentity: UserIdentity, start: FactReference[], specification: Specification) {
        return this.observableSource.read(start, specification);
    }

    feed(userIdentity: UserIdentity, feed: Feed, bookmark: string): Promise<FactFeed> {
        return this.observableSource.feed(feed, bookmark);
    }

    load(userIdentity: UserIdentity, references: FactReference[]) {
        return this.observableSource.load(references);
    }

    async save(userIdentity: UserIdentity, facts: FactRecord[]) {
        if (!this.authorizationEngine) {
            const envelopes = await this.observableSource.save(facts.map(fact => ({
                fact,
                signatures: []
            })));
            return envelopes.map(envelope => envelope.fact);
        }

        const userFact = await this.keystore.getUserFact(userIdentity);
        const authorizedFacts = await this.authorizationEngine.authorizeFacts(facts, userFact);
        const signedFacts = await this.keystore.signFacts(userIdentity, authorizedFacts);
        const envelopes = await this.observableSource.save(signedFacts);
        return envelopes.map(envelope => envelope.fact);
    }
}
