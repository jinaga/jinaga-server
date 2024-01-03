import {
    AuthorizationRules,
    buildModel,
    dehydrateFact,
    FactEnvelope,
    FactManager,
    FactRecord,
    hydrate,
    MemoryStore,
    NetworkNoOp,
    ObservableSource,
    PassThroughFork,
    User
} from "jinaga";

import { AuthorizationKeystore } from "../../src/authorization/authorization-keystore";
import { MemoryKeystore } from "../../src/memory/memory-keystore";

class Hashtag {
    public static Type = "Hashtag" as const;
    public type = Hashtag.Type;

    constructor(
        public word: string
    ) { }
}

class Tweet {
    public static Type = "Tweet" as const;
    public type = Tweet.Type;

    constructor(
        public message: string,
        public sender: User
    ) { }
}

class Like {
    public static Type = "Like" as const;
    public type = Like.Type;

    constructor(
        public user: User,
        public tweet: Tweet
    ) { }
}

class Delete {
    public static Type = "Delete" as const;
    public type = Delete.Type;

    constructor(
        public tweet: Tweet
    ) { }
}

describe('Authorization', () => {
    it('should authorize empty save', async () => {
        const authorization = givenAuthorization();
        const result = await whenSave(authorization, []);
        expect(result.length).toEqual(0);
    });

    it('should save a new fact', async () => {
        const authorization = givenAuthorization();
        const result = await whenSave(authorization, dehydrateFact(new Hashtag('vorpal')));
        expect(result.length).toEqual(1);
    });

    it('should save a fact once', async () => {
        const authorization = givenAuthorization();
        const facts = dehydrateFact(new Hashtag('vorpal'));
        await whenSave(authorization, facts);
        const result = await whenSave(authorization, facts);
        expect(result.length).toEqual(0);
    });

    it('should reject a fact from an unauthorized user', async () => {
        const authorization = givenAuthorization();
        const mickeyMouse = givenOtherUser();
        const promise = whenSave(authorization, dehydrateFact(new Tweet("Twas brillig", mickeyMouse)));
        await expect(promise).rejects.not.toBeNull();
    });

    it('should accept a fact from an authorized user', async () => {
        const authorization = givenAuthorization();
        const lewiscarrol = await givenLoggedInUser(authorization);
        const result = await whenSave(authorization, dehydrateFact(new Tweet("Twas brillig", lewiscarrol)));
        expect(result.length).toBeGreaterThan(0);
    });

    it('should accept a predecessor from an authorized user', async () => {
        const authorization = givenAuthorization();
        const lewiscarrol = await givenLoggedInUser(authorization);
        const result = await whenSave(authorization, dehydrateFact(new Like(lewiscarrol, new Tweet('Twas Brillig', lewiscarrol))));
        expect(result.filter(r => r.fact.type === 'Tweet').length).toEqual(1);
    });

    it('should reject a predecessor from an unauthorized user', async () => {
        const authorization = givenAuthorization();
        const lewiscarrol = await givenLoggedInUser(authorization);
        const mickeyMouse = givenOtherUser();
        const promise = whenSave(authorization, dehydrateFact(new Like(lewiscarrol, new Tweet("Hiya, Pal!", mickeyMouse))));
        await expect(promise).rejects.not.toBeNull();
    });

    it('should accept a pre-existing predecessor from an unauthorized user', async () => {
        const storage = givenStorage();
        const mickeyMouse = givenOtherUser();
        const tweet = new Tweet("Hiya, Pal!", mickeyMouse);
        await storage.save(dehydrateFact(tweet).map(f => ({ fact: f, signatures: [] })));

        const authorization = givenAuthorizationWithStorage(storage);
        const lewiscarrol = await givenLoggedInUser(authorization);
        const result = await whenSave(authorization, dehydrateFact({
            type: 'Like',
            user: lewiscarrol,
            tweet: tweet
        }));
        expect(result.length).toBeGreaterThan(0);
        expect(result.filter(r => r.fact.type === 'Tweet').length).toEqual(0);
    });

    it('should accept a fact authorized by predecessor', async () => {
        const authorization = givenAuthorization();
        const lewiscarrol = await givenLoggedInUser(authorization);
        const tweet = new Tweet("Twas brillig", lewiscarrol);
        await whenSave(authorization, dehydrateFact(tweet));

        const result = await whenSave(authorization, dehydrateFact({
            type: 'Delete',
            tweet: tweet
        }));
        expect(result.length).toBeGreaterThan(0);
    });

    it('should accept a fact based on in-flight predecessor', async () => {
        const authorization = givenAuthorization();
        const lewiscarrol = await givenLoggedInUser(authorization);
        const tweet = new Tweet("Twas brillig", lewiscarrol);
        // Note that this is missing.
        // await whenSave(authorization, dehydrateFact(tweet));
        
        const result = await whenSave(authorization, dehydrateFact({
            type: 'Delete',
            tweet: tweet
        }));
        expect(result.length).toBeGreaterThan(0);
    });
});

function givenAuthorization() {
    const storage = givenStorage();
    return givenAuthorizationWithStorage(storage);
}

function givenStorage() {
    return new MemoryStore();
}

function givenAuthorizationWithStorage(storage: MemoryStore) {
    const keystore = new MemoryKeystore();
    keystore.getOrCreateUserFact(givenMockUserIdentity());
    const fork = new PassThroughFork(storage);
    const observableSource = new ObservableSource(storage);
    const network = new NetworkNoOp();
    const factManager = new FactManager(fork, observableSource, storage, network);
    const model = buildModel(b => b
        .type(Hashtag)
        .type(User)
        .type(Tweet, m => m
            .predecessor("sender", User))
        .type(Like, m => m
            .predecessor("user", User)
            .predecessor("tweet", Tweet))
        .type(Delete, m => m
            .predecessor("tweet", Tweet))
    );
    const authorizationRules = new AuthorizationRules(model)
        .any(Hashtag)
        .no(User)
        .type(Tweet, t => t.sender)
        .type(Like, l => l.user)
        .type(Delete, d => d.tweet.sender)
        ;
    return new AuthorizationKeystore(factManager, storage, keystore, authorizationRules, null);
}

function givenOtherUser() {
    return new User('other');
}

async function givenLoggedInUser(authorization: AuthorizationKeystore) {
    const userIdentity = givenMockUserIdentity();
    const userFact = await authorization.getOrCreateUserFact(userIdentity);
    const user = hydrate<User>(userFact);
    return user;
}

function givenMockUserIdentity() {
    return {
        provider: 'mock',
        id: 'user'
    };
}

async function whenSave(authorization: AuthorizationKeystore, facts: FactRecord[]) {
    const userIdentity = givenMockUserIdentity();
    const envelopes: FactEnvelope[] = facts.map(f => ({ fact: f, signatures: [] }));
    const result = await authorization.save(userIdentity, envelopes);
    return result;
}