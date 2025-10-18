import { Handler, NextFunction, Request, Response, Router } from "express";
import {
    Authorization,
    buildFeeds,
    computeObjectHash,
    computeTupleSubsetHash,
    Declaration,
    FactEnvelope,
    FactManager,
    FactRecord,
    FactReference,
    FeedCache,
    FeedObject,
    FeedResponse,
    FeedsResponse,
    Forbidden,
    GraphDeserializer,
    GraphSerializer,
    GraphSource,
    Invalid,
    invertSpecification,
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

    constructor(
        private factManager: FactManager,
        private authorization: Authorization,
        private feedCache: FeedCache,
        private allowedOrigin: string | string[] | ((origin: string, callback: (err: Error | null, allow?: boolean) => void) => void)
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
            await graphSource.read(async (envelopes) => {
                if (!verifyEnvelopes(envelopes)) {
                    throw new Forbidden("The signatures on the facts are invalid.");
                }
                await this.authorization.save(userIdentity, envelopes);
            });
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

            // Verify that I can distribute all feeds to the user.
            const feeds = buildFeeds(specification);
            const userIdentity = serializeUserIdentity(user);
            await this.authorization.verifyDistribution(userIdentity, feeds, namedStart);

            const feedHashes = this.feedCache.addFeeds(feeds, namedStart);

            return {
                feeds: feedHashes
            }
        });
    }

    private feed(user: RequestUser | null, params: { [key: string]: string }, query: qs.ParsedQs): Promise<FeedResponse | null> {
        return Trace.dependency("feed", params["hash"], async () => {
            const feedHash = params["hash"];
            if (!feedHash) {
                return null;
            }

            const feedDefinition = await this.feedCache.getFeed(feedHash);
            if (!feedDefinition) {
                return null;
            }

            const bookmark = query["b"] as string ?? "";

            const userIdentity = serializeUserIdentity(user);
            const start = feedDefinition.feed.given.map(g => feedDefinition.namedStart[g.label.name]);
            const results = await this.authorization.feed(userIdentity, feedDefinition.feed, start, bookmark);
            // Return distinct fact references from all the tuples.
            const references = results.tuples.flatMap(t => t.facts).filter((value, index, self) =>
                self.findIndex(f => f.hash === value.hash && f.type === value.type) === index
            );
            const response: FeedResponse = {
                references,
                bookmark: results.bookmark
            };
            return response;
        });
    }

    private async streamFeed(user: RequestUser | null, params: { [key: string]: string }, query: qs.ParsedQs): Promise<Stream<FeedResponse> | null> {
        const connectionId = Math.random().toString(36).substring(2, 10);
        const startTime = Date.now();
        
        console.log(`[StreamFeed:${connectionId}] NEW CONNECTION - User: ${user?.id || 'anonymous'}, Hash: ${params["hash"]}`);
        
        const feedHash = params["hash"];
        if (!feedHash) {
            console.log(`[StreamFeed:${connectionId}] No feed hash provided`);
            return null;
        }

        const feedDefinition = await this.feedCache.getFeed(feedHash);
        if (!feedDefinition) {
            console.log(`[StreamFeed:${connectionId}] Feed definition not found for hash: ${feedHash}`);
            return null;
        }

        let bookmark = query["b"] as string ?? "";
        console.log(`[StreamFeed:${connectionId}] Initial bookmark: ${bookmark || 'empty'}`);

        const userIdentity = serializeUserIdentity(user);
        const start = feedDefinition.feed.given.map(g => feedDefinition.namedStart[g.label.name]);
        const givenHash = computeObjectHash(feedDefinition.namedStart);

        console.log(`[StreamFeed:${connectionId}] Feed setup - Given hash: ${givenHash.substring(0, 8)}..., Start facts: ${start.length}`);

        const stream = new Stream<FeedResponse>();
        
        try {
            // Continuous initial query until exhausted
            console.log(`[StreamFeed:${connectionId}] Starting initial data streaming...`);
            const initialStart = Date.now();
            bookmark = await this.streamAllInitialResults(userIdentity, feedDefinition, start, bookmark, stream);
            const initialDuration = Date.now() - initialStart;
            console.log(`[StreamFeed:${connectionId}] Initial data streaming complete - Duration: ${initialDuration}ms, Final bookmark: ${bookmark || 'empty'}`);
            
            // Set up real-time listeners after initial data is complete
            console.log(`[StreamFeed:${connectionId}] Setting up real-time listeners...`);
            const inverses = invertSpecification(feedDefinition.feed);
            console.log(`[StreamFeed:${connectionId}] Created ${inverses.length} inverse specifications`);
            
            const listeners = inverses.map((inverse, index) => {
                console.log(`[StreamFeed:${connectionId}] Adding listener ${index + 1}/${inverses.length}`);
                
                return this.factManager.addSpecificationListener(
                    inverse.inverseSpecification,
                    async (results) => {
                        const eventStart = Date.now();
                        console.log(`[StreamFeed:${connectionId}] EVENT RECEIVED - Listener ${index + 1}, Results: ${results.length}`);
                        
                        try {
                            // Filter out results that do not match the given.
                            const matchingResults = results.filter(pr =>
                                givenHash === computeTupleSubsetHash(pr.tuple, inverse.givenSubset));
                            
                            console.log(`[StreamFeed:${connectionId}] Filtered results - Matching: ${matchingResults.length}/${results.length}`);
                            
                            if (matchingResults.length != 0) {
                                console.log(`[StreamFeed:${connectionId}] Processing matching results...`);
                                const responseStart = Date.now();
                                bookmark = await this.streamFeedResponse(userIdentity, feedDefinition, start, bookmark, stream, true);
                                const responseDuration = Date.now() - responseStart;
                                console.log(`[StreamFeed:${connectionId}] Feed response sent - Duration: ${responseDuration}ms, New bookmark: ${bookmark || 'empty'}`);
                            } else {
                                console.log(`[StreamFeed:${connectionId}] No matching results - skipping response`);
                            }
                        } catch (error) {
                            console.error(`[StreamFeed:${connectionId}] ERROR processing event: ${error}`);
                        }
                        
                        const eventDuration = Date.now() - eventStart;
                        if (eventDuration > 100) {
                            console.warn(`[StreamFeed:${connectionId}] SLOW event processing - Duration: ${eventDuration}ms`);
                        }
                    }
                );
            });
            
            console.log(`[StreamFeed:${connectionId}] All listeners registered - Count: ${listeners.length}`);
            
            stream.done(() => {
                const cleanupStart = Date.now();
                console.log(`[StreamFeed:${connectionId}] CLEANUP STARTED - Removing ${listeners.length} listeners`);
                
                for (let i = 0; i < listeners.length; i++) {
                    try {
                        this.factManager.removeSpecificationListener(listeners[i]);
                        console.log(`[StreamFeed:${connectionId}] Removed listener ${i + 1}/${listeners.length}`);
                    } catch (error) {
                        console.error(`[StreamFeed:${connectionId}] ERROR removing listener ${i + 1}: ${error}`);
                    }
                }
                
                const cleanupDuration = Date.now() - cleanupStart;
                const totalDuration = Date.now() - startTime;
                console.log(`[StreamFeed:${connectionId}] CLEANUP COMPLETE - Cleanup duration: ${cleanupDuration}ms, Total connection duration: ${totalDuration}ms`);
            });
            
            const setupDuration = Date.now() - startTime;
            console.log(`[StreamFeed:${connectionId}] Stream setup complete - Duration: ${setupDuration}ms`);
            
            return stream;
            
        } catch (error) {
            console.error(`[StreamFeed:${connectionId}] ERROR during setup: ${error}`);
            throw error;
        }
    }

    private async streamAllInitialResults(
        userIdentity: UserIdentity | null,
        feedDefinition: FeedObject,
        start: FactReference[],
        initialBookmark: string,
        stream: Stream<FeedResponse>
    ): Promise<string> {
        const streamId = Math.random().toString(36).substring(2, 8);
        console.log(`[InitialResults:${streamId}] Starting initial data fetch - Bookmark: ${initialBookmark || 'empty'}`);
        
        let bookmark = initialBookmark;
        let hasMoreResults = true;
        let pageCount = 0;
        let totalReferences = 0;
        const maxPages = 1000; // Safety limit to prevent infinite loops
        const startTime = Date.now();
        
        while (hasMoreResults && pageCount < maxPages) {
            const pageStart = Date.now();
            console.log(`[InitialResults:${streamId}] Fetching page ${pageCount + 1} - Bookmark: ${bookmark || 'empty'}`);
            
            const results = await this.authorization.feed(userIdentity, feedDefinition.feed, start, bookmark);
            const fetchDuration = Date.now() - pageStart;
            
            console.log(`[InitialResults:${streamId}] Page ${pageCount + 1} fetched - Tuples: ${results.tuples.length}, Duration: ${fetchDuration}ms`);
            
            // Check if we got results
            if (results.tuples.length === 0) {
                console.log(`[InitialResults:${streamId}] No more results - ending pagination`);
                hasMoreResults = false;
                break;
            }
            
            // Process and send results
            const processStart = Date.now();
            const references = results.tuples.flatMap(t => t.facts).filter((value, index, self) =>
                self.findIndex(f => f.hash === value.hash && f.type === value.type) === index
            );
            const processDuration = Date.now() - processStart;
            
            console.log(`[InitialResults:${streamId}] Page ${pageCount + 1} processed - References: ${references.length}, Process duration: ${processDuration}ms`);
            
            if (references.length > 0) {
                const response: FeedResponse = {
                    references,
                    bookmark: results.bookmark
                };
                
                const feedStart = Date.now();
                stream.feed(response);
                const feedDuration = Date.now() - feedStart;
                
                totalReferences += references.length;
                console.log(`[InitialResults:${streamId}] Page ${pageCount + 1} sent to stream - Feed duration: ${feedDuration}ms`);
            }
            
            // Update bookmark for next iteration
            const newBookmark = results.bookmark;
            if (newBookmark === bookmark) {
                console.log(`[InitialResults:${streamId}] Bookmark unchanged - ending pagination`);
                hasMoreResults = false;
            } else {
                bookmark = newBookmark;
            }
            
            // Check if we got fewer results than the page size (indicates end)
            if (results.tuples.length < 100) {
                console.log(`[InitialResults:${streamId}] Partial page received (${results.tuples.length} < 100) - ending pagination`);
                hasMoreResults = false;
            }
            
            pageCount++;
            
            // Add small delay to prevent overwhelming the database
            if (hasMoreResults && pageCount % 10 === 0) {
                console.log(`[InitialResults:${streamId}] Adding delay after ${pageCount} pages`);
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        
        const totalDuration = Date.now() - startTime;
        console.log(`[InitialResults:${streamId}] Initial data streaming complete - Pages: ${pageCount}, Total references: ${totalReferences}, Duration: ${totalDuration}ms, Final bookmark: ${bookmark || 'empty'}`);
        
        if (pageCount >= maxPages) {
            console.warn(`[InitialResults:${streamId}] Hit maximum page limit (${maxPages}) - possible infinite loop`);
        }
        
        return bookmark;
    }

    private async streamFeedResponse(userIdentity: UserIdentity | null, feedDefinition: FeedObject, start: FactReference[], bookmark: string, stream: Stream<FeedResponse>, skipIfEmpty = false): Promise<string> {
        const responseId = Math.random().toString(36).substring(2, 6);
        const startTime = Date.now();
        
        console.log(`[FeedResponse:${responseId}] Starting feed response - Bookmark: ${bookmark || 'empty'}, Skip if empty: ${skipIfEmpty}`);
        
        const feedStart = Date.now();
        const results = await this.authorization.feed(userIdentity, feedDefinition.feed, start, bookmark);
        const feedDuration = Date.now() - feedStart;
        
        console.log(`[FeedResponse:${responseId}] Authorization feed complete - Tuples: ${results.tuples.length}, Duration: ${feedDuration}ms`);
        
        // Return distinct fact references from all the tuples.
        const processStart = Date.now();
        const references = results.tuples.flatMap(t => t.facts).filter((value, index, self) =>
            self.findIndex(f => f.hash === value.hash && f.type === value.type) === index
        );
        const processDuration = Date.now() - processStart;
        
        console.log(`[FeedResponse:${responseId}] References processed - Count: ${references.length}, Duration: ${processDuration}ms`);
        
        if (!skipIfEmpty || references.length > 0) {
            const response: FeedResponse = {
                references,
                bookmark: results.bookmark
            };
            
            const streamStart = Date.now();
            stream.feed(response);
            const streamDuration = Date.now() - streamStart;
            
            console.log(`[FeedResponse:${responseId}] Response sent to stream - Duration: ${streamDuration}ms`);
        } else {
            console.log(`[FeedResponse:${responseId}] Skipping empty response`);
        }
        
        const totalDuration = Date.now() - startTime;
        console.log(`[FeedResponse:${responseId}] Feed response complete - New bookmark: ${results.bookmark || 'empty'}, Total duration: ${totalDuration}ms`);
        
        return results.bookmark;
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
    else if (typeof obj === "object") {
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

function handleError(error: any, req: Request, res: Response, next: NextFunction) {
    const requestPath = req.path;
    if (error instanceof Forbidden) {
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
