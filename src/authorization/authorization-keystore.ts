import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    Feed,
    Query,
    Specification,
    Storage,
    UserIdentity
} from "jinaga";

import { Keystore } from "../keystore";

export class AuthorizationKeystore implements Authorization {
    private authorizationEngine: AuthorizationEngine | null;

    constructor(
        private store: Storage,
        private keystore: Keystore,
        authorizationRules: AuthorizationRules | null
    ) {
        this.authorizationEngine = authorizationRules &&
            new AuthorizationEngine(authorizationRules, store);
    }

    async getOrCreateUserFact(userIdentity: UserIdentity) {
        const userFact = await this.keystore.getOrCreateUserFact(userIdentity);
        const envelopes = [
            <FactEnvelope>{
                fact: userFact,
                signatures: []
            }
        ];
        await this.store.save(envelopes);
        return userFact;
    }

    query(userIdentity: UserIdentity, start: FactReference, query: Query) {
        return this.store.query(start, query);
    }

    async read(userIdentity: UserIdentity, start: FactReference[], specification: Specification) {
        const projectedResult = await this.store.read(start, specification);
        return projectedResult.map(p => p.result);
    }

    feed(userIdentity: UserIdentity, feed: Feed, bookmark: string): Promise<FactFeed> {
        return this.store.feed(feed, bookmark);
    }

    load(userIdentity: UserIdentity, references: FactReference[]) {
        return this.store.load(references);
    }

    async save(userIdentity: UserIdentity | null, facts: FactRecord[]) {
        if (!this.authorizationEngine) {
            const envelopes = await this.store.save(facts.map(fact => ({
                fact,
                signatures: []
            })));
            return envelopes.map(envelope => envelope.fact);
        }

        const userFact = userIdentity ? await this.keystore.getUserFact(userIdentity) : null;
        const authorizedFacts = await this.authorizationEngine.authorizeFacts(facts, userFact);
        if (userIdentity) {
            const signedFacts = await this.keystore.signFacts(userIdentity, authorizedFacts);
            const envelopes = await this.store.save(signedFacts);
            return envelopes.map(envelope => envelope.fact);
        }
        else {
            return authorizedFacts;
        }
    }
}
