import { Handler, NextFunction, Request, Response, Router } from "express";
import {
    Authorization,
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
    LoadMessage,
    LoadResponse,
    ProfileMessage,
    ProjectedResult,
    ReferencesByName,
    Specification,
    SpecificationParser,
    Trace,
    UserIdentity,
    buildFeeds,
    computeObjectHash,
    computeTupleSubsetHash,
    invertSpecification,
    parseLoadMessage,
    parseSaveMessage
} from "jinaga";
import { Stream } from "./stream";
import { createLineReader } from "./line-reader";

interface ParsedQs { [key: string]: undefined | string | string[] | ParsedQs | ParsedQs[] }

function getOrStream<U>(
    getMethod: ((req: RequestUser, params: { [key: string]: string }, query: ParsedQs) => Promise<U | null>),
    streamMethod: ((req: RequestUser, params: { [key: string]: string }, query: ParsedQs) => Promise<Stream<U> | null>)
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const accept = req.headers["accept"];
        if (accept && accept.indexOf("application/x-jinaga-feed-stream") >= 0) {
            streamMethod(user, req.params, req.query)
                .then(response => {
                    if (!response) {
                        res.sendStatus(404);
                        next();
                    }
                    else {
                        res.type("application/x-jinaga-feed-stream");
                        res.set("Connection", "keep-alive");
                        res.set("Cache-Control", "no-cache");
                        res.set("Access-Control-Allow-Origin", "*");
                        res.flushHeaders();
                        req.on("close", () => {
                            response.close();
                        });
                        const timeout = setTimeout(() => {
                            response.close();
                        }, 5 * 60 * 1000);
                        response
                            .next(data => {
                                res.write(JSON.stringify(data) + "\n\n");
                            })
                            .done(() => {
                                clearTimeout(timeout);
                                res.socket?.end();
                            });
                    }
                })
                .catch(error => {
                    if (error instanceof Forbidden) {
                        res.type("text");
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.status(500).send(error.message);
                    }
                    next();
                });
        }
        else {
            getMethod(user, req.params, req.query)
                .then(response => {
                    if (!response) {
                        res.sendStatus(404);
                        next();
                    }
                    else {
                        res.type("json");
                        res.send(JSON.stringify(response));
                        next();
                    }
                })
                .catch(error => {
                    if (error instanceof Forbidden) {
                        res.type("text");
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.status(500).send(error.message);
                    }
                    next();
                });
        }
    };
}

function getAuthenticate<U>(method: ((req: RequestUser, params?: { [key: string]: string }) => Promise<U>)): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
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
                .catch(error => {
                    Trace.error(error);
                    res.sendStatus(500);
                    next();
                });
        }
    };
}

function post<T, U>(
    parse: (input: any) => T,
    method: (user: RequestUser, message: T, params?: { [key: string]: string }) => Promise<U>,
    output: (result: U, res: Response, accepts: (type: string) => string | false) => void
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
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
            .catch(error => {
                if (error instanceof Forbidden) {
                    Trace.warn(error.message);
                    res.type("text");
                    res.status(403).send(error.message);
                }
                else {
                    Trace.error(error);
                    res.type("text");
                    res.status(500).send(error.message);
                }
                next();
            });
    };
}

function postString<U>(method: (user: RequestUser, message: string) => Promise<U>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const input = parseString(req.body);
        if (!input || typeof (input) !== 'string') {
            res.type("text");
            res.status(500).send('Expected Content-Type text/plain. Ensure that you have called app.use(express.text()).');
        }
        else {
            method(user, input)
                .then(response => {
                    res.type("text");
                    res.send(JSON.stringify(response, null, 2));
                    next();
                })
                .catch(error => {
                    if (error instanceof Forbidden) {
                        Trace.warn(error.message);
                        res.type("text");
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.type("text");
                        res.status(400).send(error.message);
                    }
                    next();
                });
        }
    };
}

function postCreate<T>(
    parse: (request: Request) => T,
    method: (user: RequestUser, message: T) => Promise<void>
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const message = parse(req);
        method(user, message)
            .then(_ => {
                res.sendStatus(201);
                next();
            })
            .catch(error => {
                if (error instanceof Forbidden) {
                    Trace.warn(error.message);
                    res.type("text");
                    res.status(403).send(error.message);
                }
                else {
                    Trace.error(error);
                    res.type("text");
                    res.status(500).send(error.message);
                }
                next();
            });
    };
}

function postStringCreate(method: (user: RequestUser, message: string) => Promise<void>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
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
                .catch(error => {
                    if (error instanceof Forbidden) {
                        Trace.warn(error.message);
                        res.type("text");
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.type("text");
                        res.status(400).send(error.message);
                    }
                    next();
                });
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
        router.get('/login', getAuthenticate(user => this.login(user)));
        router.post('/load', post(
            parseLoadMessage,
            (user, loadMessage) => this.load(user, loadMessage),
            outputGraph
        ));
        router.post('/save', postCreate(
            inputSaveMessage,
            (user, graphSource) => this.save(user, graphSource)
        ));

        router.post('/read', postString((user, input: string) => this.read(user, input)));
        router.post('/write', postStringCreate((user, input: string) => this.write(user, input)));
        router.post('/feeds', post(
            parseString,
            (user, input: string, accepts) => this.feeds(user, input),
            outputFeeds
        ));
        router.get('/feeds/:hash', getOrStream<FeedResponse>(
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

    private async login(user: RequestUser) {
        const userFact = await this.authorization.getOrCreateUserFact({
            provider: user.provider,
            id: user.id
        });
        return {
            userFact: userFact,
            profile: user.profile
        };
    }

    private async load(user: RequestUser, loadMessage: LoadMessage): Promise<FactEnvelope[]> {
        const userIdentity = serializeUserIdentity(user);
        const result = await this.authorization.load(userIdentity, loadMessage.references);
        return result;
    }

    private async save(user: RequestUser | null, graphSource: GraphSource): Promise<void> {
        const userIdentity = serializeUserIdentity(user);
        await graphSource.read(async (envelopes) => {
            await this.authorization.save(userIdentity, envelopes);
        });
    }

    private async read(user: RequestUser | null, input: string): Promise<any[]> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
        parser.expectEnd();
        const start = this.selectStart(specification, declaration);

        const userIdentity = serializeUserIdentity(user);
        const results = await this.authorization.read(userIdentity, start, specification);
        return extractResults(results);
    }

    private async write(user: RequestUser | null, input: string): Promise<void> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        var declaration = parser.parseDeclaration(knownFacts);
        parser.expectEnd();

        const factRecords: FactRecord[] = [];
        for (const value of declaration) {
            if (!value.declared.fact) {
                throw new Error("References are not allowed while saving.");
            }
            factRecords.push(value.declared.fact);
        }

        const userIdentity = serializeUserIdentity(user);
        await this.authorization.save(userIdentity, factRecords
            .map(fact => ({
                fact: fact,
                signatures: []
            })));
    }

    private async feeds(user: RequestUser | null, input: string): Promise<FeedsResponse> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
        const start = this.selectStart(specification, declaration);

        // Verify that the number of start facts equals the number of inputs
        if (start.length !== specification.given.length) {
            throw new Error(`The number of start facts (${start.length}) does not equal the number of inputs (${specification.given.length})`);
        }
        // Verify that the input type matches the start fact type
        for (let i = 0; i < start.length; i++) {
            if (start[i].type !== specification.given[i].type) {
                throw new Error(`The type of start fact ${i} (${start[i].type}) does not match the type of input ${i} (${specification.given[i].type})`);
            }
        }
        
        const namedStart = specification.given.reduce((map, label, index) => ({
            ...map,
            [label.name]: start[index]
        }), {} as ReferencesByName);

        // Verify that I can distribute all feeds to the user.
        const feeds = buildFeeds(specification);
        const userIdentity = serializeUserIdentity(user);
        await this.authorization.verifyDistribution(userIdentity, feeds, namedStart);

        const feedHashes = this.feedCache.addFeeds(feeds, namedStart);

        return {
            feeds: feedHashes
        }
    }

    private async feed(user: RequestUser | null, params: { [key: string]: string }, query: ParsedQs): Promise<FeedResponse | null> {
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
        const start = feedDefinition.feed.given.map(label => feedDefinition.namedStart[label.name]);
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
    }

    private async streamFeed(user: RequestUser | null, params: { [key: string]: string }, query: ParsedQs): Promise<Stream<FeedResponse> | null> {
        const feedHash = params["hash"];
        if (!feedHash) {
            return null;
        }

        const feedDefinition = await this.feedCache.getFeed(feedHash);
        if (!feedDefinition) {
            return null;
        }

        let bookmark = query["b"] as string ?? "";

        const userIdentity = serializeUserIdentity(user);
        const start = feedDefinition.feed.given.map(label => feedDefinition.namedStart[label.name]);
        const givenHash = computeObjectHash(feedDefinition.namedStart);

        const stream = new Stream<FeedResponse>();
        Trace.info("Initial response");
        bookmark = await this.streamFeedResponse(userIdentity, feedDefinition, start, bookmark, stream);
        const inverses = invertSpecification(feedDefinition.feed);
        const listeners = inverses.map(inverse => this.factManager.addSpecificationListener(
            inverse.inverseSpecification,
            async (results) => {
                // Filter out results that do not match the given.
                const matchingResults = results.filter(pr =>
                    givenHash === computeTupleSubsetHash(pr.tuple, inverse.givenSubset));
                if (matchingResults.length != 0) {
                    bookmark = await this.streamFeedResponse(userIdentity, feedDefinition, start, bookmark, stream, true);
                }
            }
        ));
        stream.done(() => {
            Trace.info("Done");
            for (const listener of listeners) {
                this.factManager.removeSpecificationListener(listener);
            }
        });
        return stream;
    }

    private async streamFeedResponse(userIdentity: UserIdentity | null, feedDefinition: FeedObject, start: FactReference[], bookmark: string, stream: Stream<FeedResponse>, skipIfEmpty = false): Promise<string> {
        const results = await this.authorization.feed(userIdentity, feedDefinition.feed, start, bookmark);
        // Return distinct fact references from all the tuples.
        const references = results.tuples.flatMap(t => t.facts).filter((value, index, self) => self.findIndex(f => f.hash === value.hash && f.type === value.type) === index
        );
        if (!skipIfEmpty || references.length > 0) {
            const response: FeedResponse = {
                references,
                bookmark: results.bookmark
            };
            stream.feed(response);
        }
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
            const declaredFact = declaration.find(d => d.name === input.name);
            if (!declaredFact) {
                throw new Error(`No fact named ${input.name} was declared`);
            }
            return declaredFact.declared.reference;
        });
    }

    private setOptions(router: Router, path: string): OptionsConfiguration {
        const addOptions = (allowedMethods: string[], allowedHeaders: string[], allowedTypes: string[]) => {
            router.options(path, this.applyAllowOrigin((req, res) => {
                res.set('Allow', allowedMethods.join(', '));
                res.set('Access-Control-Allow-Methods', allowedMethods.join(', '));
                res.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
                if (allowedTypes.length > 0) {
                    res.set('Accept-Post', allowedTypes.join(', '));
                }
                res.status(204).send();
            }));
        }

        return {
            intendedForGet: () => {
                addOptions(['GET', 'OPTIONS'], ['Accept', 'Authorization'], []);
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
                            contentTypes);
                    },
                    returningNoContent: () => {
                        addOptions(
                            ['POST', 'OPTIONS'],
                            ['Content-Type', 'Authorization'],
                            contentTypes);
                    }
                };
            }
        };
    }

    private applyAllowOrigin(sendResponse: (req: Request, res: Response) => void) {
        // Specify the allowed origins.
        return (req: Request, res: Response, next: NextFunction) => {
            let requestOrigin = req.get('Origin');

            if (typeof this.allowedOrigin === 'string') {
                // If allowedOrigin is a string, use it as the value of the Access-Control-Allow-Origin header
                res.set('Access-Control-Allow-Origin', this.allowedOrigin);
                sendResponse(req, res);
            } else if (Array.isArray(this.allowedOrigin)) {
                // If allowedOrigin is an array, check if the request's origin is in the array
                if (requestOrigin && this.allowedOrigin.includes(requestOrigin)) {
                    res.set('Access-Control-Allow-Origin', requestOrigin);
                }
                sendResponse(req, res);
            } else if (typeof this.allowedOrigin === 'function' && requestOrigin) {
                // If allowedOrigin is a function, call it with the request's origin
                this.allowedOrigin(requestOrigin, (err, allow) => {
                    if (err) {
                        next(err);
                    } else if (allow) {
                        res.set('Access-Control-Allow-Origin', requestOrigin);
                    }
                    sendResponse(req, res);
                });
            } else {
                sendResponse(req, res);
            }
        };
    }
}

function parseString(input: any): string {
    if (typeof input !== 'string') {
        throw new Error("Expected a string. Check the content type of the request.");
    }
    return input;
}

function extractResults(obj: any): any {
    if (Array.isArray(obj)) {
        const projectedResults: ProjectedResult[] = obj;
        return projectedResults.map(r => extractResults(r.result));
    }
    else if (typeof obj === "object") {
        return Object.keys(obj).reduce((acc, key) => ({
            ...acc,
            [key]: extractResults(obj[key])
        }), {});
    }
    else {
        return obj;
    }
}

interface OptionsConfiguration {
    intendedForGet(): ResponseConfiguration;
    intendedForPost(...contentTypes: string[]): ResponseConfiguration;
}

interface ResponseConfiguration {
    returningContent(): void;
    returningNoContent(): void;
}