import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    DistributionEngine,
    DistributionRules,
    FactEnvelope,
    FactFeed,
    FactManager,
    FactReference,
    Forbidden,
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

    async read(userIdentity: UserIdentity | null, start: FactReference[], specification: Specification) {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const namedStart = specification.given.reduce((map, g, index) => ({
                ...map,
                [g.label.name]: start[index]
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
            const namedStart = specification.given.reduce((map, g, index) => ({
                ...map,
                [g.label.name]: start[index]
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

    async save(userIdentity: UserIdentity | null, envelopes: FactEnvelope[]): Promise<FactEnvelope[]> {
        if (this.authorizationEngine) {
            const userFact = userIdentity ? await this.keystore.getUserFact(userIdentity) : null;
            const results = await this.authorizationEngine.authorizeFacts(envelopes, userFact);
            const userKeys : string[] = (userFact && userFact.fields.hasOwnProperty("publicKey"))
                ? [ userFact.fields.publicKey ]
                : [];
            const factsToSign = results
                .filter(r => r.verdict === "Accept" && r.newPublicKeys.some(k => userKeys.includes(k)))
                .map(r => r.fact);
            const signedFacts = (userIdentity && factsToSign.length > 0)
                ? await this.keystore.signFacts(userIdentity, factsToSign)
                : [];
            const authorizedEnvelopes: FactEnvelope[] = results.map(r => {
                const isFact = factReferenceEquals(r.fact);
                const envelope = envelopes.find(e => isFact(e.fact));
                if (!envelope) {
                    throw new Error("Fact not found in envelopes.");
                }
                if (r.verdict === "Accept") {
                    const signedFact = signedFacts.find(f => isFact(f.fact));
                    const userSignatures = signedFact
                        ? signedFact.signatures
                        : [];
                    return {
                        fact: r.fact,
                        signatures: envelope.signatures
                            .filter(s => r.newPublicKeys.includes(s.publicKey))
                            .concat(userSignatures)
                    };
                }
                else if (r.verdict === "Existing") {
                    return envelope;
                }
                else {
                    throw new Error("Unexpected verdict.");
                }
            });
            const savedEnvelopes = await this.factManager.save(authorizedEnvelopes);
            return savedEnvelopes;
        }
        else {
            const savedEnvelopes = await this.factManager.save(envelopes);
            return savedEnvelopes;
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
