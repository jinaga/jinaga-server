import { Handler, Router } from "express";
import {
    Authorization,
    Declaration,
    FactManager,
    FactRecord,
    FactReference,
    FeedCache,
    FeedObject,
    FeedResponse,
    FeedsResponse,
    Forbidden,
    LoadMessage,
    LoadResponse,
    ProfileMessage,
    ProjectedResult,
    ReferencesByName,
    SaveMessage,
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
                                res.socket.end();
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
    method: (user: RequestUser, message: T, params?: { [key: string]: string }) => Promise<U>
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
                    res.type("json");
                    res.send(JSON.stringify(response));
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
    parse: (input: any) => T,
    method: (user: RequestUser, message: T) => Promise<void>
): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const message = parse(req.body);
        if (!message) {
            throw new Error('Ensure that you have called app.use(express.json()).');
        }
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

export interface RequestUser {
    provider: string;
    id: string;
    profile: ProfileMessage;
}

export class HttpRouter {
    handler: Handler;

    constructor(private factManager: FactManager, private authorization: Authorization, private feedCache: FeedCache) {
        const router = Router();
        router.get('/login', getAuthenticate(user => this.login(user)));
        router.post('/load', post(
            parseLoadMessage,
            (user, loadMessage) => this.load(user, loadMessage)
        ));
        router.post('/save', postCreate(
            parseSaveMessage,
            (user, saveMessage) => this.save(user, saveMessage)
        ));

        router.post('/read', postString((user, input: string) => this.read(user, input)));
        router.post('/write', postStringCreate((user, input: string) => this.write(user, input)));
        router.post('/feeds', post(
            parseString,
            (user, input: string) => this.feeds(user, input)
        ));
        router.get('/feeds/:hash', getOrStream<FeedResponse>(
            (user, params, query) => this.feed(user, params, query),
            (user, params, query) => this.streamFeed(user, params, query)));

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

    private async load(user: RequestUser, loadMessage: LoadMessage): Promise<LoadResponse> {
        const userIdentity = serializeUserIdentity(user);
        const result = await this.authorization.load(userIdentity, loadMessage.references);
        const facts = result.map(r => r.fact);
        return {
            facts
        };
    }

    private async save(user: RequestUser | null, saveMessage: SaveMessage): Promise<void> {
        const userIdentity = serializeUserIdentity(user);
        await this.authorization.save(userIdentity, saveMessage.facts
            .map(fact => ({
                fact: fact,
                signatures: []
            })));
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