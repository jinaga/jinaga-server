import { Handler, Router } from "express";
import {
    Authorization,
    Declaration,
    FactRecord,
    FactReference,
    Feed,
    FeedResponse,
    FeedsResponse,
    Forbidden,
    LoadMessage,
    LoadResponse,
    ProfileMessage,
    ProjectedResult,
    QueryMessage,
    QueryResponse,
    SaveMessage,
    Specification,
    SpecificationParser,
    Trace,
    UserIdentity,
    buildFeeds,
    computeObjectHash,
    fromDescriptiveString,
} from "jinaga";

import { FeedCache, FeedDefinition } from "./feed-cache";

interface ParsedQs { [key: string]: undefined | string | string[] | ParsedQs | ParsedQs[] }

function get<U>(method: ((req: RequestUser, params: { [key: string]: string }, query: ParsedQs) => Promise<U>)): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        method(user, req.params, req.query)
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

function post<T, U>(method: (user: RequestUser, message: T, params?: { [key: string]: string }) => Promise<U>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const message = <T>req.body;
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
        const input = <string>req.body;
        if (!input || typeof(input) !== 'string') {
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

function postCreate<T>(method: (user: RequestUser, message: T) => Promise<void>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const message = <T>req.body;
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
        const input = <string>req.body;
        if (!input || typeof(input) !== 'string') {
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

function serializeUserIdentity(user: RequestUser | null) : UserIdentity | null {
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

    constructor(private authorization: Authorization, private feedCache: FeedCache, backwardCompatible: boolean) {
        const router = Router();
        router.get('/login', getAuthenticate(user => this.login(user)));
        if (backwardCompatible) {
            router.post('/query', post((user, queryMessage: QueryMessage) => this.query(user, queryMessage)));
        }
        router.post('/load', post((user, loadMessage: LoadMessage) => this.load(user, loadMessage)));
        router.post('/save', postCreate((user, saveMessage: SaveMessage) => this.save(user, saveMessage)));

        router.post('/read', postString((user, input: string) => this.read(user, input)));
        router.post('/write', postStringCreate((user, input: string) => this.write(user, input)));
        router.post('/feeds', post((user, input: string) => this.feeds(user, input)));
        router.get('/feeds/:hash', get((user, params, query) => this.feed(user, params, query)));

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

    private async query(user: RequestUser | null, queryMessage: QueryMessage) : Promise<QueryResponse> {
        const userIdentity = serializeUserIdentity(user);
        const query = fromDescriptiveString(queryMessage.query);
        const result = await this.authorization.query(userIdentity, queryMessage.start, query);
        return {
            results: result
        };
    }

    private async load(user: RequestUser, loadMessage: LoadMessage) : Promise<LoadResponse> {
        const userIdentity = serializeUserIdentity(user);
        const result = await this.authorization.load(userIdentity, loadMessage.references);
        return {
            facts: result
        };
    }

    private async save(user: RequestUser | null, saveMessage: SaveMessage) : Promise<void> {
        const userIdentity = serializeUserIdentity(user);
        await this.authorization.save(userIdentity, saveMessage.facts);
    }

    private async read(user: RequestUser | null, input: string): Promise<any[]> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
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

        const factRecords: FactRecord[] = [];
        for (const value of declaration) {
            if (!value.declared.fact) {
                throw new Error("References are not allowed while saving.");
            }
            factRecords.push(value.declared.fact);
        }

        const userIdentity = serializeUserIdentity(user);
        await this.authorization.save(userIdentity, factRecords);
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

        // Verify that I can distribute all feeds to the user.
        const feeds = buildFeeds(specification);
        const userIdentity = serializeUserIdentity(user);
        await this.authorization.verifyDistribution(userIdentity, feeds, start);

        const feedDefinitionsByHash = feeds.map(feed => {
            const indexedStart = feed.inputs.map(input => ({
                factReference: start[input.inputIndex],
                index: input.inputIndex
            }));
            const feedDefinition: FeedDefinition = {
                start: indexedStart,
                feed
            };
            return {
                hash: urlSafeHash(feed),
                feedDefinition
            };
        });
        // Store all feeds in the cache.
        for (const d of feedDefinitionsByHash) {
            await this.feedCache.storeFeed(d.hash, d.feedDefinition);
        }

        return {
            feeds: feedDefinitionsByHash.map(f => f.hash)
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
        const start = feedDefinition.start.reduce((start, input) => {
            start[input.index] = input.factReference;
            return start;
        }, [] as FactReference[]);
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

    private selectStart(specification: Specification, declaration: Declaration) : FactReference[] {
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

function urlSafeHash(feed: Feed): string {
    const base64 = computeObjectHash(feed);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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