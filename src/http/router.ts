import { Handler, Router } from "express";
import {
    Authorization,
    buildFeeds,
    computeObjectHash,
    Declaration,
    FactRecord,
    FactReference,
    Forbidden,
    fromDescriptiveString,
    LoadMessage,
    LoadResponse,
    ProfileMessage,
    QueryMessage,
    QueryResponse,
    SaveMessage,
    SaveResponse,
    Specification,
    SpecificationParser,
    Trace,
    UserIdentity,
} from "jinaga";
import { FeedsResponse } from "jinaga/dist/http/messages";
import { FeedCache } from "./feed-cache";

function get<U>(method: ((req: RequestUser) => Promise<U>)): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        if (!user) {
            res.sendStatus(401);
        }
        else {
            method(user)
                .then(response => {
                    res.setHeader('Content-Type', 'application/json');
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

function post<T, U>(method: (user: RequestUser, message: T) => Promise<U>): Handler {
    return (req, res, next) => {
        const user = <RequestUser>req.user;
        const message = <T>req.body;
        if (!message) {
            throw new Error('Ensure that you have called app.use(express.json()).');
        }
        method(user, message)
            .then(response => {
                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify(response));
                next();
            })
            .catch(error => {
                if (error instanceof Forbidden) {
                    Trace.warn(error.message);
                    res.setHeader('Content-Type', 'text/plain');
                    res.status(403).send(error.message);
                }
                else {
                    Trace.error(error);
                    res.setHeader('Content-Type', 'text/plain');
                    res.sendStatus(500).send(error.message);
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
            res.setHeader('Content-Type', 'text/plain');
            res.status(500).send('Expected Content-Type text/plain. Ensure that you have called app.use(express.text()).');
        }
        else {
            method(user, input)
                .then(response => {
                    res.setHeader('Content-Type', 'application/json');
                    res.send(JSON.stringify(response, null, 2));
                    next();
                })
                .catch(error => {
                    if (error instanceof Forbidden) {
                        Trace.warn(error.message);
                        res.setHeader('Content-Type', 'text/plain');
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.setHeader('Content-Type', 'text/plain');
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
                    res.setHeader('Content-Type', 'text/plain');
                    res.status(403).send(error.message);
                }
                else {
                    Trace.error(error);
                    res.setHeader('Content-Type', 'text/plain');
                    res.sendStatus(500).send(error.message);
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
            res.setHeader('Content-Type', 'text/plain');
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
                        res.setHeader('Content-Type', 'text/plain');
                        res.status(403).send(error.message);
                    }
                    else {
                        Trace.error(error);
                        res.setHeader('Content-Type', 'text/plain');
                        res.status(400).send(error.message);
                    }
                    next();
                });
        }
    };
}

function serializeUserIdentity(user: RequestUser) : UserIdentity {
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

    constructor(private authorization: Authorization, private feedCache: FeedCache) {
        const router = Router();
        router.get('/login', get(user => this.login(user)));
        router.post('/query', post((user, queryMessage: QueryMessage) => this.query(user, queryMessage)));
        router.post('/load', post((user, loadMessage: LoadMessage) => this.load(user, loadMessage)));
        router.post('/save', postCreate((user, saveMessage: SaveMessage) => this.save(user, saveMessage)));

        router.post('/read', postString((user, input: string) => this.read(user, input)));
        router.post('/write', postStringCreate((user, input: string) => this.write(user, input)));
        router.post('/feeds', post((user, input: string) => this.feeds(user, input)));

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

    private async query(user: RequestUser, queryMessage: QueryMessage) : Promise<QueryResponse> {
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

    private async save(user: RequestUser, saveMessage: SaveMessage) : Promise<void> {
        const userIdentity = serializeUserIdentity(user);
        await this.authorization.save(userIdentity, saveMessage.facts);
    }

    private async read(user: RequestUser, input: string): Promise<any[]> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
        const start = this.selectStart(specification, declaration);

        const userIdentity = serializeUserIdentity(user);
        const results = await this.authorization.read(userIdentity, start, specification);
        return results;
    }

    private async write(user: RequestUser, input: string): Promise<void> {
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

    private async feeds(user: RequestUser, input: string): Promise<FeedsResponse> {
        const knownFacts = await this.getKnownFacts(user);
        const parser = new SpecificationParser(input);
        parser.skipWhitespace();
        const declaration = parser.parseDeclaration(knownFacts);
        const specification = parser.parseSpecification();
        const start = this.selectStart(specification, declaration);

        const feedDefinitions = buildFeeds(start, specification).map(feed => ({
            hash: computeObjectHash(feed),
            feed
        }));
        // Store all feeds in the cache.
        for (const feedDefinition of feedDefinitions) {
            await this.feedCache.storeFeed(feedDefinition.hash, feedDefinition.feed);
        }

        return {
            feeds: feedDefinitions.map(f => f.hash)
        }
    }

    private async getKnownFacts(user: RequestUser): Promise<Declaration> {
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