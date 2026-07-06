import { Handler, NextFunction, Request, Response, Router } from "express";
import {
    Authorization,
    buildFeeds,
    computeObjectHash,
    Declaration,
    DistributionDenialCode,
    FactEnvelope,
    FactManager,
    FactRecord,
    FactReference,
    FeedCache,
    FeedDecision,
    FeedResponse,
    FeedsResponse,
    Forbidden,
    GraphDeserializer,
    GraphSerializer,
    GraphSource,
    Invalid,
    LoadMessage,
    LoadResponse,
    parseLoadMessage,
    parseSaveMessage,
    ProfileMessage,
    ProjectedResult,
    ReferencesByName,
    Specification,
    SpecificationParser,
    Trace,
    UserIdentity,
    verifyEnvelopes
} from "jinaga";
import { DistributionIntersectionBranch, FeedResult, SubscriptionAuthorizer } from "../authorization/authorization-keystore";
import { FeedStreamSession, FeedStreamSessionConfig } from "../feeds/feed-stream-session";
import { CsvMetadata } from "./csv-metadata";
import { validateSpecificationForCsv } from "./csv-validator";
import { createLineReader } from "./line-reader";
import { outputReadResultsStreaming } from "./output-formatters";
import { arrayToResultStream, ResultStream } from "./result-stream";
import { Stream } from "./stream";

function getOrStream<U>(
    getMethod: ((req: RequestUser, params: { [key: string]: string }, query: qs.ParsedQs) => Promise<U | null>),
    streamMethod: ((req: RequestUser, params: { [key: string]: string }, query: qs.ParsedQs) => Promise<Stream<U> | null>)
): Handler {
    return (req, res, next) => {
        const connectionId = Math.random().toString(36).substring(2, 10);
        const user = <RequestUser>(req as any).user;
        const accept = req.headers["accept"];
        
        console.log(`[HttpConnection:${connectionId}] New request - User: ${user?.id || 'anonymous'}, Accept: ${accept}, URL: ${req.url}`);
        
        if (accept && accept.indexOf("application/x-jinaga-feed-stream") >= 0) {
            console.log(`[HttpConnection:${connectionId}] STREAMING request detected`);
            
            streamMethod(user, req.params, req.query)
                .then(response => {
                    if (!response) {
                        console.log(`[HttpConnection:${connectionId}] Stream method returned null - sending 404`);
                        res.sendStatus(404);
                        next();
                    }
                    else {
                        console.log(`[HttpConnection:${connectionId}] Setting up streaming response`);
                        
                        res.type("application/x-jinaga-feed-stream");
                        res.set("Connection", "keep-alive");
                        res.set("Cache-Control", "no-cache");
                        res.set("Access-Control-Allow-Origin", "*");
                        res.flushHeaders();
                        
                        console.log(`[HttpConnection:${connectionId}] Headers flushed - setting up event handlers`);
                        
                        let clientDisconnected = false;
                        let timeoutTriggered = false;
                        let streamClosed = false;
                        
                        // Client disconnect handler
                        req.on("close", () => {
                            console.log(`[HttpConnection:${connectionId}] CLIENT DISCONNECTED`);
                            clientDisconnected = true;
                            if (!streamClosed) {
                                console.log(`[HttpConnection:${connectionId}] Closing stream due to client disconnect`);
                                response.close();
                                streamClosed = true;
                            }
                        });
                        
                        // Timeout handler
                        const timeout = setTimeout(() => {
                            console.log(`[HttpConnection:${connectionId}] TIMEOUT TRIGGERED (5 minutes)`);
                            timeoutTriggered = true;
                            if (!streamClosed) {
                                console.log(`[HttpConnection:${connectionId}] Closing stream due to timeout`);
                                response.close();
                                streamClosed = true;
                            }
                        }, 5 * 60 * 1000);
                        
                        let messageCount = 0;
                        
                        response
                            .next(data => {
                                messageCount++;
                                const writeStart = Date.now();
                                
                                if (clientDisconnected) {
                                    console.warn(`[HttpConnection:${connectionId}] Attempted to write to disconnected client - Message #${messageCount}`);
                                    return;
                                }
                                
                                try {
                                    const jsonData = JSON.stringify(data) + "\n\n";
                                    res.write(jsonData);
                                    const writeDuration = Date.now() - writeStart;
                                    
                                    console.log(`[HttpConnection:${connectionId}] Message #${messageCount} sent - Size: ${jsonData.length} bytes, Duration: ${writeDuration}ms`);
                                    
                                    if (writeDuration > 50) {
                                        console.warn(`[HttpConnection:${connectionId}] SLOW write operation - Duration: ${writeDuration}ms`);
                                    }
                                } catch (error) {
                                    console.error(`[HttpConnection:${connectionId}] ERROR writing message #${messageCount}: ${error}`);
                                }
                            })
                            .done(() => {
                                console.log(`[HttpConnection:${connectionId}] STREAM DONE - Messages sent: ${messageCount}, Client disconnected: ${clientDisconnected}, Timeout triggered: ${timeoutTriggered}`);
                                
                                clearTimeout(timeout);
                                streamClosed = true;
                                
                                try {
                                    if (!clientDisconnected) {
                                        console.log(`[HttpConnection:${connectionId}] Ending socket connection`);
                                        res.socket?.end();
                                    } else {
                                        console.log(`[HttpConnection:${connectionId}] Client already disconnected - skipping socket end`);
                                    }
                                } catch (error) {
                                    console.error(`[HttpConnection:${connectionId}] ERROR ending socket: ${error}`);
                                }
                            });
                        
                        console.log(`[HttpConnection:${connectionId}] Stream handlers configured`);
                    }
                })
                .catch(error => {
                    console.error(`[HttpConnection:${connectionId}] ERROR in stream method: ${error}`);
                    handleError(error, req, res, next);
                });
        }
        else {
            console.log(`[HttpConnection:${connectionId}] Regular GET request`);
            getMethod(user, req.params, req.query)
                .then(response => {
                    if (!response) {
                        console.log(`[HttpConnection:${connectionId}] Get method returned null - sending 404`);
                        res.sendStatus(404);
                        next();
                    }
                    else {
                        console.log(`[HttpConnection:${connectionId}] Sending JSON response`);
                        res.type("json");
                        res.send(JSON.stringify(response));
                        next();
                    }
                })
                .catch(error => {
                    console.error(`[HttpConnection:${connectionId}] ERROR in get method: ${error}`);
                    handleError(error, req, res, next);
                });
        }
    };
}

function getAuthenticate<U>(method: ((req: RequestUser, params?: { [key: string]: string }) => Promise<U>)): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        if (!user) {
            res.sendStatus(401);
        }
        else {
            method(user, req.params)
                .then(response => {
                    res.type("json");
                    res.send(JSON.stringify(response));
                    next();
                })
                .catch(error => handleError(error, req, res, next));
        }
    };
}

function post<T, U>(
    parse: (input: any) => T,
    method: (user: RequestUser, message: T, params?: { [key: string]: string }) => Promise<U>,
    output: (result: U, res: Response, accepts: (type: string) => string | false) => void
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const message = parse(req.body);
        if (!message) {
            throw new Error('Ensure that you have called app.use(express.json()).');
        }
        method(user, message, req.params)
            .then(response => {
                if (!response) {
                    res.sendStatus(404);
                    next();
                }
                else {
                    output(response, res, (type) => req.accepts(type));
                    next();
                }
            })
        .catch(error => handleError(error, req, res, next));
    };
}

function postCreate<T>(
    parse: (request: Request) => T,
    method: (user: RequestUser, message: T) => Promise<void>
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const message = parse(req);
        method(user, message)
            .then(_ => {
                res.sendStatus(201);
                next();
            })
            .catch(error => handleError(error, req, res, next));
    };
}

function postStringCreate(method: (user: RequestUser, message: string) => Promise<void>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const input = parseString(req.body);
        if (!input || typeof (input) !== 'string') {
            res.type("text");
            res.status(500).send('Expected Content-Type text/plain. Ensure that you have called app.use(express.text()).');
        }
        else {
            method(user, input)
                .then(_ => {
                    res.sendStatus(201);
                    next();
                })
                .catch(error => handleError(error, req, res, next));
        }
    };
}

function postReadWithStreaming(
    method: (user: RequestUser, message: string, acceptType: string) => Promise<{
        resultStream: ResultStream<any>,
        csvMetadata?: CsvMetadata
    }>
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>(req as any).user;
        const input = parseString(req.body);
        if (!input || typeof (input) !== 'string') {
            res.type("text");
            res.status(500).send('Expected Content-Type text/plain. Ensure that you have called app.use(express.text()).');
        }
        else {
            // Check if Accept header explicitly prefers a specific format
            const acceptHeader = req.get('Accept');
            let acceptType: string = 'text/plain'; // Default for backward compatibility

            if (acceptHeader && acceptHeader !== '*/*') {
                // Only use req.accepts() when there's a specific preference
                const preferredType = req.accepts(['text/csv', 'application/x-ndjson', 'application/json', 'text/plain']);
                acceptType = preferredType ? String(preferredType) : 'text/plain';
            }
            
            method(user, input, acceptType)
                .then(({resultStream, csvMetadata}) => {
                    outputReadResults(resultStream, res, acceptType, csvMetadata);
                    next();
                })
                .catch(error => handleError(error, req, res, next));
        }
    };
}

function subscriptionOwnerKey(userIdentity: UserIdentity | null): string | null {
    return userIdentity ? `${userIdentity.provider}|${userIdentity.id}` : null;
}

function serializeUserIdentity(user: RequestUser | null): UserIdentity | null {
    if (!user) {
        return null;
    }
    return {
        provider: user.provider,
        id: user.id
    };
}

function inputSaveMessage(req: Request): GraphSource {
    if (req.is('application/x-jinaga-graph-v1')) {
        // Convert the request into a function that reads one line at a time.
        const readLine = createLineReader(req);

        return new GraphDeserializer(readLine);
    }
    else {
        return {
            read: async (onEnvelopes) => {
                const message = parseSaveMessage(req.body);
                if (!message) {
                    throw new Error('Ensure that you have called app.use(express.json()).');
                }
                await onEnvelopes(message.facts.map(fact => ({
                    fact: fact,
                    signatures: []
                })));
            }
        };
    }
}

function outputGraph(result: FactEnvelope[], res: Response, accepts: (type: string) => string | false) {
    if (accepts("application/x-jinaga-graph-v1")) {
        res.type("application/x-jinaga-graph-v1");
        const serializer = new GraphSerializer(
            (chunk: string) => res.write(chunk)
        );
        serializer.serialize(result);
        res.end();
    }
    else {
        res.type("json");
        const loadResponse: LoadResponse = {
            facts: result.map(r => r.fact)
        };
        res.send(JSON.stringify(loadResponse));
    }
}

function outputFeeds(result: FeedsResponse, res: Response, accepts: (type: string) => string | false) {
    res.type("json");
    res.send(JSON.stringify(result));
}

function outputReadResults(
    result: ResultStream<any>, 
    res: Response, 
    acceptType: string,
    csvMetadata?: CsvMetadata
) {
    // Use streaming output formatter
    outputReadResultsStreaming(result, res, acceptType, csvMetadata)
        .catch(error => {
            console.error('Error in outputReadResults:', error);
            if (!res.headersSent) {
                res.status(500).send('Internal server error');
            }
        });
}

export interface RequestUser {
    provider: string;
    id: string;
    profile: ProfileMessage;
}

export class HttpRouter {
    handler: Handler;
    // Map from feed hash → owning user key, for feeds the server cleared
    // via intersection. The cached spec self-filters by the lifted auth
    // condition (the requesting user's fact is baked into start), so it
    // is safe to skip the per-query distribution check — but ONLY for
    // the same user who originally requested the subscription. Another
    // authenticated user who somehow obtained the hash must go through
    // the normal authorization.feed path, which will deny their request
    // since the intersected spec is not authorizable in its own right.
    private intersectedFeedOwners = new Map<string, string | null>();

    constructor(
        private factManager: FactManager,
        private authorization: Authorization & SubscriptionAuthorizer,
        private feedCache: FeedCache,
        private allowedOrigin: string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void),
        private feedStreamConfig: Partial<FeedStreamSessionConfig> = {}
    ) {
        const router = Router();
        const applyAllowOrigin = this.applyAllowOrigin.bind(this);
        router.get('/login', applyAllowOrigin, getAuthenticate(user => this.login(user)));
        router.post('/load', applyAllowOrigin, post(
            parseLoadMessage,
            (user, loadMessage) => this.load(user, loadMessage),
            outputGraph
        ));
        router.post('/save', applyAllowOrigin, postCreate(
            inputSaveMessage,
            (user, graphSource) => this.save(user, graphSource)
        ));

        router.post('/read', applyAllowOrigin, postReadWithStreaming((user, input: string, acceptType: string) =>
            this.readWithStreaming(
                user,
                input,
                acceptType === 'text/csv' ? preProcessForCsv : preProcessForOther
            )
        ));
        router.post('/write', applyAllowOrigin, postStringCreate((user, input: string) => this.write(user, input)));
        router.post('/feeds', applyAllowOrigin, post(
            parseString,
            (user, input: string, accepts) => this.feeds(user, input),
            outputFeeds
        ));
        router.get('/feeds/:hash', applyAllowOrigin, getOrStream<FeedResponse>(
            (user, params, query) => this.feed(user, params, query),
            (user, params, query) => this.streamFeed(user, params, query)));

        // Respond to OPTIONS requests to describe the methods and content types
        // that are supported.
        this.setOptions(router, '/login')
            .intendedForGet()
            .returningContent();
        this.setOptions(router, '/load')
            .intendedForPost('application/json')
            .returningContent();
        this.setOptions(router, '/save')
            .intendedForPost('application/json', 'application/x-jinaga-graph-v1')
            .returningNoContent();
        this.setOptions(router, '/read')
            .intendedForPost('text/plain')
            .returningContent();
        this.setOptions(router, '/write')
            .intendedForPost('text/plain')
            .returningNoContent();
        this.setOptions(router, '/feeds')
            .intendedForPost('text/plain')
            .returningContent();
        this.setOptions(router, '/feeds/:hash')
            .intendedForGet()
            .returningContent();

        this.handler = router;
    }

    private login(user: RequestUser) {
        return Trace.dependency("login", user.provider, async () => {
            const userFact = await this.authorization.getOrCreateUserFact({
                provider: user.provider,
                id: user.id
            });
            return {
                userFact: userFact,
                profile: user.profile
            };
        });
    }

    private load(user: RequestUser, loadMessage: LoadMessage): Promise<FactEnvelope[]> {
        return Trace.dependency("load", "", async () => {
            const userIdentity = serializeUserIdentity(user);
            const result = await this.authorization.load(userIdentity, loadMessage.references);
            return result;
        });
    }

    private save(user: RequestUser | null, graphSource: GraphSource): Promise<void> {
        return Trace.dependency("save", "", async () => {
            const userIdentity = serializeUserIdentity(user);
            // Signatures are verified per flush as they stream in, but the
            // envelopes are accumulated and authorized as a single batch.
            // Otherwise, a graph body that flushes in chunks (GraphDeserializer
            // flushes every 20 facts) would authorize each chunk independently,
            // and a fact whose rule needs a predecessor from an earlier chunk
            // would fail with "The fact <type>:<hash> is not defined." (issue #175).
            const allEnvelopes: FactEnvelope[] = [];
            await graphSource.read(async (envelopes) => {
                if (!verifyEnvelopes(envelopes)) {
                    throw new Forbidden("The signatures on the facts are invalid.");
                }
                allEnvelopes.push(...envelopes);
            });
            try {
                await this.authorization.save(userIdentity, allEnvelopes);
            } catch (error) {
                throw toSaveAuthorizationError(error, allEnvelopes);
            }
        });
    }

    /**
     * Read with streaming support.
     * Uses readStream if available on the authorization object, otherwise falls back to read().
     * 
     * When CSV format is requested, validates that the specification contains only flat projections.
     */
    private async readWithStreaming(
        user: RequestUser | null, 
        input: string,
        preProcess: (specification: Specification) => CsvMetadata | undefined
    ): Promise<{
        resultStream: ResultStream<any>,
        csvMetadata?: CsvMetadata
    }> {
        return Trace.dependency("readWithStreaming", "", async () => {
            const knownFacts = await this.getKnownFacts(user);
            const parser = new SpecificationParser(input);
            parser.skipWhitespace();
            const declaration = parser.parseDeclaration(knownFacts);
            const specification = parser.parseSpecification();
            parser.expectEnd();

            var failures: string[] = this.factManager.testSpecificationForCompliance(specification);
            if (failures.length > 0) {
                throw new Invalid(failures.join("\n"));
            }

            const csvMetadata = preProcess(specification);

            const userIdentity = serializeUserIdentity(user);
            const start = this.selectStart(specification, declaration);
            const results = await this.authorization.read(userIdentity, start, specification);
            const extracted = extractResults(results);
            Trace.counter("facts_read", extracted.count);
            const resultStream = arrayToResultStream(extracted.result);

            return {
                resultStream,
                csvMetadata
            };
        });
    }

    private write(user: RequestUser | null, input: string): Promise<void> {
        return Trace.dependency("write", "", async () => {
            const knownFacts = await this.getKnownFacts(user);
            const parser = new SpecificationParser(input);
            parser.skipWhitespace();
            var declaration = parser.parseDeclaration(knownFacts);
            parser.expectEnd();

            const factRecords: FactRecord[] = [];
            for (const value of declaration) {
                if (!value.declared.fact) {
                    throw new Invalid("References are not allowed while saving.");
                }
                factRecords.push(value.declared.fact);
            }

            const userIdentity = serializeUserIdentity(user);
            await this.authorization.save(userIdentity, factRecords
                .map(fact => ({
                    fact: fact,
                    signatures: []
                })));
        });
    }

    private feeds(user: RequestUser | null, input: string): Promise<FeedsResponse> {
        return Trace.dependency("feeds", "", async () => {
            const knownFacts = await this.getKnownFacts(user);
            const parser = new SpecificationParser(input);
            parser.skipWhitespace();
            const declaration = parser.parseDeclaration(knownFacts);
            const specification = parser.parseSpecification();
            const start = this.selectStart(specification, declaration);

            // Verify that the number of start facts equals the number of inputs
            if (start.length !== specification.given.length) {
                throw new Invalid(`The number of start facts (${start.length}) does not equal the number of inputs (${specification.given.length})`);
            }
            // Verify that the input type matches the start fact type
            for (let i = 0; i < start.length; i++) {
                if (start[i].type !== specification.given[i].label.type) {
                    throw new Invalid(`The type of start fact ${i} (${start[i].type}) does not match the type of input ${i} (${specification.given[i].label.type})`);
                }
            }
            // Verify that the specification is compliant with purge conditions
            var failures: string[] = this.factManager.testSpecificationForCompliance(specification);
            if (failures.length > 0) {
                throw new Invalid(failures.join("\n"));
            }

            const namedStart = specification.given.reduce((map, g, index) => ({
                ...map,
                [g.label.name]: start[index]
            }), {} as ReferencesByName);

            // Resolve distribution. When the user is not authorized for the
            // original spec but the distribution rules can rewrite it via
            // intersection (jinaga.js#130), accept the subscription with
            // empty results and let the inverse engine activate it later.
            //
            // Even when no rule applies at all, accept the subscription:
            // the per-query distribution check inside streamFeed /
            // feed returns "denied" and keeps the stream alive so the
            // client can be notified the moment the authorizing fact
            // arrives. Failing /feeds here would force the client to
            // re-subscribe on a poll loop.
            const userIdentity = serializeUserIdentity(user);
            const intersectResult = await this.authorization.verifyDistributionOrIntersect(userIdentity, specification, namedStart);
            let branches: DistributionIntersectionBranch[];
            let intersected: boolean;
            if (intersectResult.type === "denied") {
                // Structured, dashboard-observable signal that a feed was
                // registered without an applicable distribution rule (issue
                // #168 S3). The metric name is stable so a backend sees
                // bounded cardinality; the denial code (a fixed 4-value enum)
                // is the measurement dimension, so authoring errors
                // (no-matching-rule / spec-more-restrictive-than-rule) are
                // distinguishable from auth states (principal-excluded /
                // not-authenticated) in CI and dashboards without grepping
                // logs. The human-readable line is retained for correlation.
                Trace.metric("distribution.unmatched", { [intersectResult.code]: 1 });
                Trace.warn(`/feeds accepting spec without applicable distribution rule (${intersectResult.code}): ${intersectResult.reason}`);
                branches = [{ start, specification }];
                intersected = false;
            } else {
                branches = intersectResult.branches;
                intersected = branches.length !== 1 || branches[0].specification !== specification;
            }

            // Classify the spec's distribution decision once; it applies to
            // every feed hash the spec produces (issue #168 S1). Registration
            // and keep-alive are unchanged — reactive and denied feeds are
            // still accepted and served exactly as before; this only reports
            // the decision. `reactive` is authorized-via-intersection: denied
            // now, self-heals when the authorizing fact arrives.
            //
            // S2: the decision is recomputed from verifyDistributionOrIntersect
            // on every POST /feeds — it is NOT cached by feed hash — so a
            // repeated request always returns the correct *per-user* decision.
            // This matters because a non-intersected feed hash is shared across
            // users (it excludes the requester's identity): the same hash is
            // `authorized` for a permitted user and `denied` for another, and
            // a `reactive` decision becomes `authorized` once the authorizing
            // fact arrives. Caching the FeedDecision by hash would leak one
            // user's decision to another. addFeeds stays idempotent on the
            // hash; only the classification is per-request.
            let decision: FeedDecision["decision"];
            let decisionCode: DistributionDenialCode | undefined;
            let decisionReason: string;
            if (intersectResult.type === "denied") {
                decision = "denied";
                decisionCode = intersectResult.code;
                decisionReason = intersectResult.reason;
            } else if (intersected) {
                decision = "reactive";
                decisionCode = intersectResult.denial?.code;
                decisionReason = intersectResult.denial?.reason
                    ?? "Authorized via intersection; awaiting the authorizing fact.";
            } else {
                decision = "authorized";
                decisionCode = undefined;
                decisionReason = "Distribution authorized.";
            }

            const ownerKey = subscriptionOwnerKey(userIdentity);
            const feedHashes: string[] = [];
            const decisions: FeedDecision[] = [];
            for (const branch of branches) {
                const branchNamedStart = branch.specification.given.reduce((map, g, index) => ({
                    ...map,
                    [g.label.name]: branch.start[index]
                }), {} as ReferencesByName);
                const branchFeeds = buildFeeds(branch.specification);
                const branchHashes = this.feedCache.addFeeds(branchFeeds, branchNamedStart);
                feedHashes.push(...branchHashes);
                for (const hash of branchHashes) {
                    decisions.push({
                        feed: hash,
                        decision,
                        ...(decisionCode !== undefined ? { code: decisionCode } : {}),
                        reason: decisionReason
                    });
                }
                if (intersected) {
                    for (const hash of branchHashes) {
                        // Bind the hash to its owner so a different
                        // authenticated user who obtains it cannot reuse
                        // the cached spec — which carries the original
                        // owner's user fact in its start — to fetch
                        // facts authorized for that owner.
                        //
                        // The map allows only one owner per hash, which
                        // relies on the invariant that intersected specs
                        // bind the requesting user's fact into start —
                        // making the hash user-specific. If two distinct
                        // owners ever collide on the same hash, that
                        // invariant has broken in intersectForSubscribe;
                        // warn so we notice instead of silently
                        // overwriting.
                        const existing = this.intersectedFeedOwners.get(hash);
                        if (existing !== undefined && existing !== ownerKey) {
                            Trace.warn(`Intersected feed hash ${hash} re-bound from owner ${existing} to ${ownerKey}; intersection invariant may be broken`);
                        }
                        this.intersectedFeedOwners.set(hash, ownerKey);
                    }
                }
            }

            return {
                feeds: feedHashes,
                decisions
            }
        });
    }

    private async queryFeed(
        feedHash: string,
        userIdentity: UserIdentity | null,
        specification: Specification,
        start: FactReference[],
        bookmark: string
    ): Promise<FeedResult> {
        const cachedOwner = this.intersectedFeedOwners.get(feedHash);
        const requesterOwner = subscriptionOwnerKey(userIdentity);
        if (cachedOwner !== undefined && cachedOwner === requesterOwner) {
            const feed = await this.authorization.feedPreVerified(userIdentity, specification, start, bookmark);
            return { type: "success", feed };
        }
        // For everyone else (different user, anonymous mismatch, or a
        // non-intersected hash) go through the normal distribution-checked
        // path. A "denied" result means the streaming / polling caller
        // serves an empty page and keeps the subscription alive.
        return await this.authorization.feedWithDistribution(userIdentity, specification, start, bookmark);
    }

    private feed(user: RequestUser | null, params: { [key: string]: string }, query: qs.ParsedQs): Promise<FeedResponse | null> {
        return Trace.dependency("feed", params["hash"], async () => {
            const feedHash = params["hash"];
            if (!feedHash) {
                // No hash in the route at all — a wrong URL, not a feed lookup.
                return null;
            }

            const feedDefinition = await this.feedCache.getFeed(feedHash);
            if (!feedDefinition) {
                // Known route, but the feed hash is unknown or expired. Signal
                // this distinctly (issue #168 S4) so the client can re-register
                // via POST /feeds instead of treating it as a routing error.
                throw new FeedNotFound(feedHash);
            }

            const bookmark = query["b"] as string ?? "";

            const userIdentity = serializeUserIdentity(user);
            const start = feedDefinition.feed.given.map(g => feedDefinition.namedStart[g.label.name]);
            const result = await this.queryFeed(feedHash, userIdentity, feedDefinition.feed, start, bookmark);
            if (result.type === "denied") {
                // The subscription has been accepted; treat poll-time
                // distribution failures as an empty page so the client
                // can keep polling and pick up results when an
                // authorizing fact arrives.
                return { references: [], bookmark } as FeedResponse;
            }
            // Return distinct fact references from all the tuples.
            const references = result.feed.tuples.flatMap(t => t.facts).filter((value, index, self) =>
                self.findIndex(f => f.hash === value.hash && f.type === value.type) === index
            );
            const response: FeedResponse = {
                references,
                bookmark: result.feed.bookmark
            };
            return response;
        });
    }

    private async streamFeed(user: RequestUser | null, params: { [key: string]: string }, query: qs.ParsedQs): Promise<Stream<FeedResponse> | null> {
        const connectionId = Math.random().toString(36).substring(2, 10);

        const feedHash = params["hash"];
        if (!feedHash) {
            // No hash in the route at all — a wrong URL, not a feed lookup.
            return null;
        }

        const feedDefinition = await this.feedCache.getFeed(feedHash);
        if (!feedDefinition) {
            // Known route, but the feed hash is unknown or expired. Signal
            // this distinctly (issue #168 S4) so the client can re-register
            // via POST /feeds instead of treating it as a routing error.
            throw new FeedNotFound(feedHash);
        }

        const bookmark = query["b"] as string ?? "";

        const userIdentity = serializeUserIdentity(user);
        const start = feedDefinition.feed.given.map(g => feedDefinition.namedStart[g.label.name]);
        const givenHash = computeObjectHash(feedDefinition.namedStart);

        const stream = new Stream<FeedResponse>();

        // The session serializes every fetch and stream operation through a
        // single bookmark-driven query cycle. Inverse and anchor observers
        // only enqueue references onto a waitlist and wake the cycle; they
        // never fetch or stream directly. This removes the race between
        // listener callbacks and bookmark mutation, guarantees tuple
        // completeness, and ensures no update is lost between pages.
        const session = new FeedStreamSession(
            (b: string) => this.queryFeed(feedHash, userIdentity, feedDefinition.feed, start, b),
            this.factManager,
            feedDefinition,
            start,
            givenHash,
            stream,
            bookmark,
            connectionId,
            this.feedStreamConfig
        );

        stream.done(() => session.dispose());
        session.start();

        return stream;
    }

    private async getKnownFacts(user: RequestUser | null): Promise<Declaration> {
        if (user) {
            const userFact = await this.authorization.getOrCreateUserFact({
                provider: user.provider,
                id: user.id
            });
            return [
                {
                    name: "me",
                    declared: {
                        fact: userFact,
                        reference: {
                            type: userFact.type,
                            hash: userFact.hash
                        }
                    }
                }
            ];
        }
        else {
            return [];
        }
    }

    private selectStart(specification: Specification, declaration: Declaration): FactReference[] {
        // Select starting facts that match the inputs
        return specification.given.map(input => {
            const declaredFact = declaration.find(d => d.name === input.label.name);
            if (!declaredFact) {
                throw new Invalid(`No fact named ${input.label.name} was declared`);
            }
            return declaredFact.declared.reference;
        });
    }

    private setOptions(router: Router, path: string): OptionsConfiguration {
        const addOptions = (allowedMethods: string[], allowedHeaders: string[], exposedHeaders: string[], allowedTypes: string[]) => {
            router.options(path, this.applyAllowOrigin.bind(this), (req: Request, res: Response) => {
                res.set('Allow', allowedMethods.join(', '));
                res.set('Access-Control-Allow-Methods', allowedMethods.join(', '));
                res.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
                res.set('Access-Control-Expose-Headers', exposedHeaders.join(', '));
                if (allowedTypes.length > 0) {
                    res.set('Accept-Post', allowedTypes.join(', '));
                }
                res.status(204).send();
            });
        }

        return {
            intendedForGet: () => {
                addOptions(['GET', 'OPTIONS'], ['Accept', 'Authorization'], [], []);
                return {
                    returningContent: () => { },
                    returningNoContent: () => { }
                };
            },
            intendedForPost: (...contentTypes: string[]) => {
                return {
                    returningContent: () => {
                        addOptions(
                            ['POST', 'OPTIONS'],
                            ['Content-Type', 'Accept', 'Authorization'],
                            ['Accept-Post'],
                            contentTypes);
                    },
                    returningNoContent: () => {
                        addOptions(
                            ['POST', 'OPTIONS'],
                            ['Content-Type', 'Authorization'],
                            ['Accept-Post'],
                            contentTypes);
                    }
                };
            }
        };
    }

    private applyAllowOrigin(req: Request, res: Response, next: NextFunction) {
        // Specify the allowed origins.
        let requestOrigin = req.get('Origin');

        if (typeof this.allowedOrigin === 'string') {
            // If allowedOrigin is a string, use it as the value of the Access-Control-Allow-Origin header
            res.set('Access-Control-Allow-Origin', this.allowedOrigin);
            next();
        } else if (Array.isArray(this.allowedOrigin)) {
            // If allowedOrigin is an array, check if the request's origin is in the array
            if (requestOrigin && this.allowedOrigin.includes(requestOrigin)) {
                res.set('Access-Control-Allow-Origin', requestOrigin);
            }
            next();
        } else if (typeof this.allowedOrigin === 'function' && requestOrigin) {
            // If allowedOrigin is a function, call it with the request's origin
            this.allowedOrigin(requestOrigin, (err, allow) => {
                if (err) {
                    next(err);
                } else if (allow) {
                    res.set('Access-Control-Allow-Origin', requestOrigin);
                }
                next();
            });
        } else {
            next();
        }
    }
}

function preProcessForCsv(specification: Specification): CsvMetadata | undefined {
    const csvMetadata = validateSpecificationForCsv(specification);

    if (!csvMetadata.isValid) {
        throw new Invalid(
            `Specification is not compatible with CSV format:\n\n` +
            csvMetadata.errors.join('\n\n') +
            `\n\nHint: CSV requires flat projections with single-valued fields. ` +
            `Avoid nested specifications.`
        );
    }
    return csvMetadata;
}

function preProcessForOther(specification: Specification): CsvMetadata | undefined {
    // For non-CSV formats, no special preprocessing is needed.
    return undefined;
}

function parseString(input: any): string {
    if (typeof input !== 'string') {
        throw new Invalid("Expected a string. Check the content type of the request.");
    }
    return input;
}

function extractResults(obj: any): { result: any, count: number } {
    if (Array.isArray(obj)) {
        const projectedResults: ProjectedResult[] = obj;
        const results = projectedResults.map(r => extractResults(r.result));
        const count = results.reduce((acc, res) => acc + res.count + 1, 0);
        return { result: results.map(r => r.result), count };
    }
    else if (obj instanceof Date) {
        // Preserve Date objects as-is
        return { result: obj, count: 0 };
    }
    else if (obj !== null && typeof obj === "object") {
        const keys = Object.keys(obj);
        const results = keys.reduce((acc, key) => {
            const extracted = extractResults(obj[key]);
            acc.result[key] = extracted.result;
            acc.count += extracted.count;
            return acc;
        }, { result: {} as any, count: 0 });
        return results;
    }
    else {
        return { result: obj, count: 0 };
    }
}

// A known/expired feed hash missed the feed cache. Distinct from a route
// miss (wrong URL) so clients can tell "unknown/expired feed hash" — which is
// recoverable by re-registering via POST /feeds — from "wrong URL" (issue
// #168 S4). handleError maps this to a 404 with a machine-readable body.
export class FeedNotFound extends Error {
    constructor(public readonly feedHash: string) {
        super(`Feed not found: ${feedHash}`);
        this.name = "FeedNotFound";
    }
}

// Authorization rule evaluation reports a missing predecessor as a plain
// Error of this shape (see authorizationRules.ts / specification-runner.ts
// in jinaga). It surfaces when the client's save request didn't include the
// full closure of facts a rule needs to walk. Map it to a diagnosable 4xx
// instead of an opaque 500 (issue #175).
const FACT_NOT_DEFINED_PATTERN = /^The fact (\S+):(\S+) is not defined\.$/;

function toSaveAuthorizationError(error: any, envelopes: FactEnvelope[]): any {
    if (error instanceof Error) {
        const match = FACT_NOT_DEFINED_PATTERN.exec(error.message);
        if (match) {
            const [, factType, factHash] = match;
            const factTypesInBatch = Array.from(new Set(envelopes.map(e => e.fact.type))).join(", ");
            Trace.warn(
                `Save authorization could not resolve predecessor ${factType}:${factHash} ` +
                `among ${envelopes.length} fact(s) in the request (types: ${factTypesInBatch}).`
            );
            return new Invalid(
                `The fact ${factType}:${factHash} is required to authorize this save but was not included in the request. ` +
                `Ensure the full closure of predecessors needed by your authorization rules is sent together.`
            );
        }
    }
    return error;
}

function handleError(error: any, req: Request, res: Response, next: NextFunction) {
    const requestPath = req.path;
    if (error instanceof FeedNotFound) {
        Trace.warn(`Feed not found: ${error.feedHash} (Path: ${requestPath})`);
        res.type("text");
        res.status(404).send("feed_not_found");
    } else if (error instanceof Forbidden) {
        Trace.warn(`Forbidden: ${error.message} (Path: ${requestPath})`);
        res.type("text");
        res.status(403).send(error.message);
    } else if (error instanceof Invalid) {
        Trace.warn(`Invalid: ${error.message} (Path: ${requestPath})`);
        res.type("text");
        res.status(400).send(error.message);
    } else {
        Trace.error(`Error: ${error.message} (Path: ${requestPath})`);
        res.type("text");
        res.status(500).send(error.message);
    }
    next();
}

interface OptionsConfiguration {
    intendedForGet(): ResponseConfiguration;
    intendedForPost(...contentTypes: string[]): ResponseConfiguration;
}

interface ResponseConfiguration {
    returningContent(): void;
    returningNoContent(): void;
}
