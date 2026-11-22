import {
    Authorization,
    AuthorizationEngine,
    AuthorizationRules,
    DistributionDenialCode,
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

export interface DistributionIntersectionBranch {
    start: FactReference[];
    specification: Specification;
}

// The engine failure that made a subscription reactive (authorized via
// intersection) or denied. Carried so POST /feeds can report the structured
// per-feed decision (issue #168 S1) without recomputing distribution.
export interface DistributionDenial {
    reason: string;
    code: DistributionDenialCode;
}

export type DistributionBranchesResult =
    // Pass-through authorized when `denial` is absent; authorized-via-
    // intersection (reactive) when `denial` carries the engine failure that
    // triggered the intersection.
    | { type: "success"; branches: DistributionIntersectionBranch[]; denial?: DistributionDenial }
    | { type: "denied"; reason: string; code: DistributionDenialCode };

export type FeedResult =
    | { type: "success"; feed: FactFeed }
    | { type: "denied"; reason: string };

export interface SubscriptionAuthorizer {
    verifyDistributionOrIntersect(
        userIdentity: UserIdentity | null,
        specification: Specification,
        namedStart: ReferencesByName
    ): Promise<DistributionBranchesResult>;
    feedPreVerified(
        userIdentity: UserIdentity | null,
        specification: Specification,
        start: FactReference[],
        bookmark: string
    ): Promise<FactFeed>;
    feedWithDistribution(
        userIdentity: UserIdentity | null,
        specification: Specification,
        start: FactReference[],
        bookmark: string
    ): Promise<FeedResult>;
}

import { instanceKey } from "../feeds/feed-identity";
import { Keystore } from "../keystore";
import { DistributedFactCache } from "./distributed-fact-cache";

function factKey(reference: FactReference): string {
    return `${reference.type}:${reference.hash}`;
}

function namedStartOf(specification: Specification, start: FactReference[]): ReferencesByName {
    return specification.given.reduce((map, given, index) => ({
        ...map,
        [given.label.name]: start[index]
    }), {} as ReferencesByName);
}

/**
 * The identity of one feed read: which feed instance, at which bookmark.
 *
 * `instanceKey` is the one definition of feed identity in this series, so
 * this composes it with the bookmark and derives nothing of its own. A feed
 * read's result depends on the feed, the facts it starts from and the
 * bookmark, and on nothing about the user, so two reads carrying equal keys
 * would return equal results.
 *
 * A given that takes no part in any match is absent from the skeleton, so
 * `instanceKey` does not carry it. That is correct rather than lossy: such a
 * start fact reaches neither the feed's output labels nor its query
 * parameters, so it cannot change what the read returns.
 */
function feedReadKey(specification: Specification, start: FactReference[], bookmark: string): string {
    return `${instanceKey(specification, namedStartOf(specification, start))}|${bookmark}`;
}

export class AuthorizationKeystore implements Authorization, SubscriptionAuthorizer {
    private authorizationEngine: AuthorizationEngine | null;
    private distributionEngine: DistributionEngine | null;
    private distributedFacts: DistributedFactCache = new DistributedFactCache();
    // The feed reads that are in flight right now, by feed read key.
    //
    // A save wakes every FeedStreamSession subscribed to the specification,
    // and each one queries on its own: `wake` starts its cycle with
    // `void this.runCycle()` (src/feeds/feed-stream-session.ts), so the
    // listener returns before the query runs and nothing upstream waits for
    // it. N sessions on one feed therefore issued N identical queries in the
    // same tick, and queued N connection acquisitions behind the pool
    // (issue #187). Merging the identical ones leaves one read per feed
    // instance and bookmark.
    private feedReadsInFlight: Map<string, Promise<FactFeed>> = new Map();

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
            const namedStart = namedStartOf(specification, start);
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
        const result = await this.feedWithDistribution(userIdentity, specification, start, bookmark);
        if (result.type === "denied") {
            throw new Forbidden(result.reason);
        }
        return result.feed;
    }

    async feedWithDistribution(userIdentity: UserIdentity | null, specification: Specification, start: FactReference[], bookmark: string): Promise<FeedResult> {
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const namedStart = namedStartOf(specification, start);
            const canDistribute = await this.distributionEngine.canDistributeToAll([specification], namedStart, userReference);
            if (canDistribute.type === "failure") {
                return { type: "denied", reason: canDistribute.reason };
            }
            const factFeed = await this.feedOnce(specification, start, bookmark);
            const factReferences = factFeed.tuples
                .flatMap(tuple => tuple.facts)
                .filter((value, index, self) => self.findIndex(factReferenceEquals(value)) === index);
            this.distributedFacts.add(factReferences, userReference);
            return { type: "success", feed: factFeed };
        }
        return { type: "success", feed: await this.feedOnce(specification, start, bookmark) };
    }

    async feedPreVerified(userIdentity: UserIdentity | null, specification: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        // Caller has already established that this feed is safe to serve
        // (e.g. produced by intersectForSubscribe — the spec lifts its own
        // authorization condition into the matches and therefore self-
        // filters). Skip the redundant per-query distribution check, but
        // keep tracking the returned references so /load stays consistent.
        const factFeed = await this.feedOnce(specification, start, bookmark);
        if (this.distributionEngine) {
            const userReference: FactReference | null = userIdentity
                ? await this.keystore.getUserFact(userIdentity)
                : null;
            const factReferences = factFeed.tuples
                .flatMap(tuple => tuple.facts)
                .filter((value, index, self) => self.findIndex(factReferenceEquals(value)) === index);
            this.distributedFacts.add(factReferences, userReference);
        }
        return factFeed;
    }

    /**
     * Read a feed page, sharing a read that is already in flight for the same
     * feed instance and bookmark.
     *
     * Only the read is shared. Everything that depends on who is asking stays
     * per call: the distribution check runs before this, and
     * `distributedFacts.add` after it.
     */
    private feedOnce(specification: Specification, start: FactReference[], bookmark: string): Promise<FactFeed> {
        const key = feedReadKey(specification, start, bookmark);
        const inFlight = this.feedReadsInFlight.get(key);
        if (inFlight) {
            return inFlight;
        }
        const read = this.store.feed(specification, start, bookmark);
        this.feedReadsInFlight.set(key, read);
        // Nothing is kept past the moment the read settles, success or
        // failure, so a call that arrives afterwards reads the store again.
        const forget = () => {
            if (this.feedReadsInFlight.get(key) === read) {
                this.feedReadsInFlight.delete(key);
            }
        };
        read.then(forget, forget);
        return read;
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
            const envelopeByFact = new Map<string, FactEnvelope>(
                envelopes.map(e => [factKey(e.fact), e]));
            const signedFactByFact = new Map<string, FactEnvelope>(
                signedFacts.map(f => [factKey(f.fact), f]));
            const authorizedEnvelopes: FactEnvelope[] = results.map(r => {
                const envelope = envelopeByFact.get(factKey(r.fact));
                if (!envelope) {
                    throw new Error("Fact not found in envelopes.");
                }
                if (r.verdict === "Accept") {
                    const signedFact = signedFactByFact.get(factKey(r.fact));
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

    async verifyDistributionOrIntersect(
        userIdentity: UserIdentity | null,
        specification: Specification,
        namedStart: ReferencesByName
    ): Promise<DistributionBranchesResult> {
        const start = specification.given.map(g => namedStart[g.label.name]);
        if (!this.distributionEngine) {
            return { type: "success", branches: [{ start, specification }] };
        }
        const userReference: FactReference | null = userIdentity
            ? await this.keystore.getUserFact(userIdentity)
            : null;
        const targetFeeds = buildFeeds(specification);
        const canDistribute = await this.distributionEngine.canDistributeToAll(targetFeeds, namedStart, userReference);
        if (canDistribute.type === "success") {
            return { type: "success", branches: [{ start, specification }] };
        }
        // Preserve the structured engine failure so the caller can classify
        // the feed (issue #168 S1). `canDistribute` is narrowed to a failure
        // here, so `code`/`reason` are available.
        const denial: DistributionDenial = { reason: canDistribute.reason, code: canDistribute.code };
        const result = await this.distributionEngine.intersectForSubscribe(start, specification, userReference);
        if (!result.intersected) {
            return { type: "denied", reason: denial.reason, code: denial.code };
        }
        // Authorized via intersection: the spec is denied for this user right
        // now (denial carries why) but self-heals once the authorizing fact
        // arrives. The router reports this as `reactive`.
        return { type: "success", branches: result.branches, denial };
    }
}
