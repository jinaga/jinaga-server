import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    Feed,
    Forbidden,
    Query,
    Specification,
    Storage,
    UserIdentity
} from "jinaga";

import { Keystore } from "../keystore";
import { DistributionEngine } from "jinaga/dist/distribution/distribution-engine";
import { DistributionRules } from "jinaga/dist/distribution/distribution-rules";

export class AuthorizationKeystore implements Authorization {
    private authorizationEngine: AuthorizationEngine | null;
    private distributionEngine: DistributionEngine | null;

    constructor(
        private store: Storage,
        private keystore: Keystore,
        authorizationRules: AuthorizationRules | null,
        distributionRules: DistributionRules | null
    ) {
        this.authorizationEngine = authorizationRules &&
            new AuthorizationEngine(authorizationRules, store);
        this.distributionEngine = distributionRules &&
            new DistributionEngine(distributionRules, store);
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

    query(userIdentity: UserIdentity | null, start: FactReference, query: Query) {
        return this.store.query(start, query);
    }

    read(userIdentity: UserIdentity | null, start: FactReference[], specification: Specification) {
        return this.store.read(start, specification);
    }

    async feed(userIdentity: UserIdentity | null, feed: Feed, start: FactReference[], bookmark: string): Promise<FactFeed> {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const canDistribute = await this.distributionEngine.canDistribute(feed, start, userReference);
            if (!canDistribute) {
                throw new Forbidden("Unauthorized");
            }
        }
        return await this.store.feed(feed, start, bookmark);
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
