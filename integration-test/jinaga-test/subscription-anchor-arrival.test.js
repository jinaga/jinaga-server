const request = require('supertest');
const { buildModel, dehydrateFact, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Validates the polling-side contract that subscribing to a spec whose
// given fact has not yet been stored is accepted, and that the data
// surfaces once the given (and a matching descendant) lands. In the
// streaming path this is what the anchor listener wakes up; the polling
// path achieves the same outcome by re-querying the store, so a Postgres-
// backed test here guards the store/feed query against a missing given
// reference.

class Note {
  static Type = "AnchorArrival.Note";
  type = Note.Type;
  constructor(author, body) {
    this.author = author;
    this.body = body;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Note, m => m.predecessor("author", User))
);

function authorization(a) {
  return a.any(User).any(Note);
}

function noteSpecText(userHash) {
  return `let p: Jinaga.User = #${userHash}\n` +
    `(p: Jinaga.User) {\n` +
    `    n: ${Note.Type} [\n` +
    `        n->author: Jinaga.User = p\n` +
    `    ]\n` +
    `} => n`;
}

describe('Subscription with not-yet-stored given fact', () => {
  let app, withSession, close;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization
    }));
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('accepts the subscription and surfaces data once the given and a descendant arrive', async () => {
    // Hand-craft a User whose hash is known but whose fact has not been
    // saved. This stands in for the "given fact arrives later" scenario
    // — the streamFeed path would activate via the anchor listener; the
    // polling path picks it up naturally on the next poll.
    const externalUser = new User('anchor-arrival-key-' + randomSuffix());
    const userHash = dehydrateFact(externalUser)
      .find(f => f.type === 'Jinaga.User').hash;

    const subscriberId = 'anchor-subscriber-' + randomSuffix();
    await asUser(withSession, subscriberId, async (j) => { await j.login(); });

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(noteSpecText(userHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);
    expect(feeds.length).toBeGreaterThan(0);
    const feedHash = feeds[0];

    // Poll #1: the given fact does not exist yet, so there can be no
    // descendants — the page is empty but the server must not 404 or
    // error.
    const firstPoll = await request(app)
      .get(`/feeds/${feedHash}`)
      .set('x-test-user-id', subscriberId);
    expect(firstPoll.status).toBe(200);
    const firstBody = JSON.parse(firstPoll.text);
    expect((firstBody.references || []).filter(r => r.type === Note.Type)).toHaveLength(0);
    const firstBookmark = firstBody.bookmark || '';

    // Save the given User fact AND a Note that joins to it.
    // j.fact(new Note(externalUser, ...)) recursively saves both, so
    // when polling resumes both the anchor and its descendant exist.
    const writerId = 'anchor-writer-' + randomSuffix();
    let noteHash;
    await asUser(withSession, writerId, async (writerJ) => {
      const note = await writerJ.fact(new Note(externalUser, 'first body'));
      noteHash = writerJ.hash(note);
    });

    const secondPoll = await request(app)
      .get(`/feeds/${feedHash}`)
      .query({ b: firstBookmark })
      .set('x-test-user-id', subscriberId);
    expect(secondPoll.status).toBe(200);
    const secondBody = JSON.parse(secondPoll.text);
    const noteRefs = (secondBody.references || []).filter(r => r.type === Note.Type);
    expect(noteRefs.map(r => r.hash)).toContain(noteHash);
  });

  it('returns an empty page (not 404) when the given fact never arrives', async () => {
    const phantomUser = new User('phantom-key-' + randomSuffix());
    const userHash = dehydrateFact(phantomUser)
      .find(f => f.type === 'Jinaga.User').hash;

    const subscriberId = 'phantom-subscriber-' + randomSuffix();
    await asUser(withSession, subscriberId, async (j) => { await j.login(); });

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(noteSpecText(userHash));
    const { feeds } = JSON.parse(feedsResponse.text);
    const feedHash = feeds[0];

    const pollResponse = await request(app)
      .get(`/feeds/${feedHash}`)
      .set('x-test-user-id', subscriberId);
    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    expect((body.references || []).filter(r => r.type === Note.Type)).toHaveLength(0);
  });
});
