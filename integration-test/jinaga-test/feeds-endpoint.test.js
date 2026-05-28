const request = require('supertest');
const { buildModel, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Baseline coverage for POST /feeds and GET /feeds/:hash that did not
// exist in the integration suite before. Independent of PR #163's
// late-auth contracts, this catches schema/router-wiring regressions on
// the subscription endpoints.

class Root {
  static Type = "FeedsEndpoint.Root";
  type = Root.Type;
  constructor(creator, identifier) {
    this.creator = creator;
    this.identifier = identifier;
  }
}

class Item {
  static Type = "FeedsEndpoint.Item";
  type = Item.Type;
  constructor(root, name) {
    this.root = root;
    this.name = name;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Root, m => m.predecessor("creator", User))
  .type(Item, m => m.predecessor("root", Root))
);

function authorization(a) {
  return a.any(User).any(Root).any(Item);
}

function itemSpecText(rootHash) {
  return `let r: ${Root.Type} = #${rootHash}\n` +
    `(r: ${Root.Type}) {\n` +
    `    i: ${Item.Type} [\n` +
    `        i->root: ${Root.Type} = r\n` +
    `    ]\n` +
    `} => i`;
}

describe('Feeds endpoint baseline', () => {
  let app, withSession, close;
  let rootHash;
  const itemHashes = [];
  let writerId;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization
    }));

    writerId = 'feeds-writer-' + randomSuffix();
    rootHash = await asUser(withSession, writerId, async (j) => {
      const { userFact } = await j.login();
      const root = await j.fact(new Root(userFact, 'r-' + randomSuffix()));
      itemHashes.length = 0;
      for (let i = 0; i < 3; i++) {
        const item = await j.fact(new Item(root, `item-${i}`));
        itemHashes.push(j.hash(item));
      }
      return j.hash(root);
    });
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('POST /feeds returns a non-empty hash list for a valid spec', async () => {
    const response = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', writerId)
      .send(itemSpecText(rootHash));

    expect(response.status).toBe(200);
    const body = JSON.parse(response.text);
    expect(Array.isArray(body.feeds)).toBe(true);
    expect(body.feeds.length).toBeGreaterThan(0);
    body.feeds.forEach(hash => {
      expect(typeof hash).toBe('string');
      expect(hash.length).toBeGreaterThan(0);
    });
  });

  it('GET /feeds/:hash returns existing items with a bookmark', async () => {
    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', writerId)
      .send(itemSpecText(rootHash));
    const { feeds } = JSON.parse(feedsResponse.text);

    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', writerId);

    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    const itemRefs = (body.references || []).filter(r => r.type === Item.Type);
    expect(itemRefs.map(r => r.hash).sort()).toEqual([...itemHashes].sort());
    expect(typeof body.bookmark).toBe('string');
  });

  it('GET /feeds/:hash returns 404 for an unknown hash', async () => {
    const response = await request(app)
      .get('/feeds/this-hash-does-not-exist-' + randomSuffix())
      .set('x-test-user-id', writerId);

    expect(response.status).toBe(404);
  });

  it('POST /feeds with malformed text returns 400', async () => {
    const response = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', writerId)
      .send('this is not a specification');

    // SpecificationParser raises an Invalid error which the router
    // translates into a 400.
    expect(response.status).toBe(400);
  });

  it('OPTIONS /feeds advertises Accept-Post', async () => {
    const response = await request(app)
      .options('/feeds');

    expect(response.status).toBe(204);
    const acceptPost = response.headers['accept-post'];
    expect(acceptPost).toBeDefined();
    expect(acceptPost).toContain('text/plain');
  });
});
