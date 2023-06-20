import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    DistributionEngine,
    DistributionRules,
    FactEnvelope,
    FactFeed,
    FactRecord,
    FactReference,
    Feed,
    Forbidden,
    Query,
    Specification,
    Storage,
    UserIdentity,
    buildFeeds
} from "jinaga";

import { Keystore } from "../keystore";

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

    async read(userIdentity: UserIdentity | null, start: FactReference[], specification: Specification) {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            // Break the specification into feeds and check distribution.
            const feeds = buildFeeds(specification);
            const canDistribute = await this.distributionEngine.canDistributeToAll(feeds, start, userReference);
            if (!canDistribute) {
                throw new Forbidden("Unauthorized");
            }
        }
        return await this.store.read(start, specification);
    }

    async feed(userIdentity: UserIdentity | null, feed: Feed, start: FactReference[], bookmark: string): Promise<FactFeed> {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const canDistribute = await this.distributionEngine.canDistributeToAll([feed], start, userReference);
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

    async verifyDistribution(userIdentity: UserIdentity | null, feeds: Feed[], start: FactReference[]): Promise<void> {
        if (!this.distributionEngine) {
            return;
        }

        const userReference: FactReference | null = userIdentity
            ? await this.keystore.getUserFact(userIdentity)
            : null;
        const canDistribute = await this.distributionEngine.canDistributeToAll(feeds, start, userReference);
        if (!canDistribute) {
            throw new Forbidden("Unauthorized");
        }
    }
}
