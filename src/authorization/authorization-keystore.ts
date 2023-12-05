import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    DistributionEngine,
    DistributionRules,
    FactEnvelope,
    FactFeed,
    FactManager,
    FactRecord,
    FactReference,
    Forbidden,
    Query,
    ReferencesByName,
    Specification,
    Storage,
    UserIdentity,
    buildFeeds,
    factReferenceEquals
} from "jinaga";

import { Keystore } from "../keystore";
import { DistributedFactCache } from "./distributed-fact-cache";

export class AuthorizationKeystore implements Authorization {
    private authorizationEngine: AuthorizationEngine | null;
    private distributionEngine: DistributionEngine | null;
    private distributedFacts: DistributedFactCache = new DistributedFactCache();

    constructor(
        private factManager: FactManager,
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
        return this.factManager.query(start, query);
    }

    async read(userIdentity: UserIdentity | null, start: FactReference[], specification: Specification) {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const namedStart = specification.given.reduce((map, label, index) => ({
                ...map,
                [label.name]: start[index]
            }), {} as ReferencesByName);
            // Break the specification into feeds and check distribution.
            const feeds = buildFeeds(specification);
            const canDistribute = await this.distributionEngine.canDistributeToAll(feeds, namedStart, userReference);
            if (canDistribute.type === "failure") {
                throw new Forbidden(canDistribute.reason);
            }
        }
        return await this.factManager.read(start, specification);
    }

    async feed(userIdentity: UserIdentity | null, specification: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const namedStart = specification.given.reduce((map, label, index) => ({
                ...map,
                [label.name]: start[index]
            }), {} as ReferencesByName);
            const canDistribute = await this.distributionEngine.canDistributeToAll([specification], namedStart, userReference);
            if (canDistribute.type === "failure") {
                throw new Forbidden(canDistribute.reason);
            }
            const factFeed = await this.store.feed(specification, start, bookmark);
            const factReferences = factFeed.tuples
                .flatMap(tuple => tuple.facts)
                .filter((value, index, self) => self.findIndex(factReferenceEquals(value)) === index);
            this.distributedFacts.add(factReferences, userReference);
            return factFeed;
        }
        else {
            return await this.store.feed(specification, start, bookmark);
        }
    }

    async load(userIdentity: UserIdentity, references: FactReference[]) {
        if (this.distributionEngine) {
            const userFact = userIdentity ? await this.keystore.getUserFact(userIdentity) : null;
            const canDistribute = this.distributedFacts.includesAll(references, userFact);
            if (!canDistribute) {
                throw new Forbidden("Unauthorized");
            }
        }
        return await this.factManager.load(references);
    }

    async save(userIdentity: UserIdentity | null, facts: FactRecord[]) {
        if (!this.authorizationEngine) {
            const envelopes = await this.factManager.save(facts.map(fact => ({
                fact,
                signatures: []
            })));
            return envelopes.map(envelope => envelope.fact);
        }

        const userFact = userIdentity ? await this.keystore.getUserFact(userIdentity) : null;
        const authorizedFacts = await this.authorizationEngine.authorizeFacts(facts, userFact);
        if (userIdentity) {
            const signedFacts = await this.keystore.signFacts(userIdentity, authorizedFacts);
            const envelopes = await this.factManager.save(signedFacts);
            return envelopes.map(envelope => envelope.fact);
        }
        else {
            return authorizedFacts;
        }
    }

    async verifyDistribution(userIdentity: UserIdentity | null, feeds: Specification[], namedStart: ReferencesByName): Promise<void> {
        if (!this.distributionEngine) {
            return;
        }

        const userReference: FactReference | null = userIdentity
            ? await this.keystore.getUserFact(userIdentity)
            : null;
        const canDistribute = await this.distributionEngine.canDistributeToAll(feeds, namedStart, userReference);
        if (canDistribute.type === "failure") {
            throw new Forbidden(canDistribute.reason);
        }
    }
}
