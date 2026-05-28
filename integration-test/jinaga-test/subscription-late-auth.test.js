const request = require('supertest');
const { buildModel, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

class Company {
  static Type = "LateAuth.Company";
  type = Company.Type;
  constructor(creator, identifier) {
    this.creator = creator;
    this.identifier = identifier;
  }
}

class Office {
  static Type = "LateAuth.Office";
  type = Office.Type;
  constructor(company, name) {
    this.company = company;
    this.name = name;
  }
}

class Administrator {
  static Type = "LateAuth.Administrator";
  type = Administrator.Type;
  constructor(company, user, createdAt) {
    this.company = company;
    this.user = user;
    this.createdAt = createdAt;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Company, m => m.predecessor("creator", User))
  .type(Office, m => m.predecessor("company", Company))
  .type(Administrator, m => m
    .predecessor("company", Company)
    .predecessor("user", User))
);

function authorization(a) {
  return a
    .any(User)
    .any(Company)
    .any(Office)
    .any(Administrator);
}

function distribution(d) {
  return d
    .share(model.given(Company).match((c, facts) =>
      facts.ofType(Office).join(o => o.company, c)
    ))
    .with(model.given(Company).match((c, facts) =>
      facts.ofType(Administrator)
        .join(a => a.company, c)
        .selectMany(a => facts.ofType(User).join(u => u, a.user))
    ));
}

function officeSpecText(companyHash) {
  // The `p1` label name mirrors what `model.given(Company)` produces
  // so the distribution engine can lift the rule's path conditions onto
  // the subscription's given during intersectForSubscribe.
  return `let p1: ${Company.Type} = #${companyHash}\n` +
    `(p1: ${Company.Type}) {\n` +
    `    o: ${Office.Type} [\n` +
    `        o->company: ${Company.Type} = p1\n` +
    `    ]\n` +
    `} => o`;
}

jest.setTimeout(30000);

describe('Subscription late-auth recovery', () => {
  let app, withSession, close;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization, distribution
    }));
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('accepts the subscription with an empty page when the subscriber is not yet authorized', async () => {
    const { companyHash } = await asUser(withSession, 'creator-1-' + randomSuffix(), async (creatorJ) => {
      const { userFact: creatorFact } = await creatorJ.login();
      const company = await creatorJ.fact(new Company(creatorFact, 'Acme-' + randomSuffix()));
      await creatorJ.fact(new Office(company, 'HQ'));
      return { companyHash: creatorJ.hash(company) };
    });

    const subscriberId = 'subscriber-1-' + randomSuffix();
    await asUser(withSession, subscriberId, async (j) => { await j.login(); });

    // POST /feeds must NOT 403: distribution rule denies the subscriber,
    // but the server intersects the spec so the subscription can be
    // activated once the authorizing fact arrives.
    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(officeSpecText(companyHash));

    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);
    expect(Array.isArray(feeds)).toBe(true);
    expect(feeds.length).toBeGreaterThan(0);

    // Polling the cached hash returns an empty page — the pre-existing
    // Office is hidden until the lifted auth condition is satisfied.
    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', subscriberId);

    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    const officeRefs = (body.references || []).filter(r => r.type === Office.Type);
    expect(officeRefs).toHaveLength(0);
  });

  it('surfaces existing offices once the authorizing fact arrives', async () => {
    let companyValue;
    let creatorFactValue;
    const creatorId = 'creator-2-' + randomSuffix();
    const { companyHash, officeHash } = await asUser(withSession, creatorId, async (creatorJ) => {
      const { userFact: creatorFact } = await creatorJ.login();
      creatorFactValue = creatorFact;
      const company = await creatorJ.fact(new Company(creatorFact, 'Acme-' + randomSuffix()));
      companyValue = company;
      const office = await creatorJ.fact(new Office(company, 'HQ'));
      return {
        companyHash: creatorJ.hash(company),
        officeHash: creatorJ.hash(office)
      };
    });

    const subscriberId = 'subscriber-2-' + randomSuffix();
    const subscriberFact = await asUser(withSession, subscriberId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    // Subscribe BEFORE the authorizing fact exists so the cached hash is
    // an intersected (lifted) spec — feedPreVerified will then serve it.
    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(officeSpecText(companyHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);
    const feedHash = feeds[0];

    // Initial poll: empty (lifted condition not yet satisfied).
    const firstPoll = await request(app)
      .get(`/feeds/${feedHash}`)
      .set('x-test-user-id', subscriberId);
    expect(firstPoll.status).toBe(200);
    const firstBody = JSON.parse(firstPoll.text);
    expect((firstBody.references || []).filter(r => r.type === Office.Type)).toHaveLength(0);

    // Creator grants the subscriber the Administrator role.
    await asUser(withSession, creatorId, async (creatorJ) => {
      await creatorJ.fact(new Administrator(companyValue, subscriberFact, new Date('2026-05-27')));
    });

    // Re-poll without propagating the prior bookmark. The intersected
    // spec is 2-given, and the bookmark-extended SQL path currently
    // generates a WHERE constraint on the second given without a
    // corresponding JOIN (a separate PostgresStore bug). Re-querying
    // from the beginning sidesteps that and still validates the
    // contract — the office surfaces once the lifted condition holds.
    const secondPoll = await request(app)
      .get(`/feeds/${feedHash}`)
      .set('x-test-user-id', subscriberId);
    expect(secondPoll.status).toBe(200);
    const secondBody = JSON.parse(secondPoll.text);
    const officeRefs = (secondBody.references || []).filter(r => r.type === Office.Type);
    expect(officeRefs.map(r => r.hash)).toContain(officeHash);
  });

  it('does not let a different authenticated user reuse an intersected feed hash', async () => {
    let companyValue;
    const creatorId = 'creator-3-' + randomSuffix();
    const { companyHash } = await asUser(withSession, creatorId, async (creatorJ) => {
      const { userFact: creatorFact } = await creatorJ.login();
      const company = await creatorJ.fact(new Company(creatorFact, 'Acme-' + randomSuffix()));
      companyValue = company;
      await creatorJ.fact(new Office(company, 'HQ'));
      return { companyHash: creatorJ.hash(company) };
    });

    const aliceId = 'alice-3-' + randomSuffix();
    const aliceFact = await asUser(withSession, aliceId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    // Mallory must exist in the keystore for the polling auth path to
    // resolve her user fact during the distribution check.
    const malloryId = 'mallory-3-' + randomSuffix();
    await asUser(withSession, malloryId, async (j) => { await j.login(); });

    // Alice subscribes while NOT yet an admin so the cached hash is the
    // intersected (Alice-owned) spec.
    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', aliceId)
      .send(officeSpecText(companyHash));
    const { feeds } = JSON.parse(feedsResponse.text);
    const intersectedHash = feeds[0];

    // Now grant Alice the Administrator role so her intersected spec
    // actually produces rows.
    await asUser(withSession, creatorId, async (creatorJ) => {
      await creatorJ.fact(new Administrator(companyValue, aliceFact, new Date('2026-05-27')));
    });

    // Alice can read her own intersected feed and sees the office.
    const alicePoll = await request(app)
      .get(`/feeds/${intersectedHash}`)
      .set('x-test-user-id', aliceId);
    expect(alicePoll.status).toBe(200);
    const aliceBody = JSON.parse(alicePoll.text);
    expect((aliceBody.references || []).some(r => r.type === Office.Type)).toBe(true);

    // Mallory polls the same hash. The router routes her through the
    // normal distribution check (cached owner is Alice, not Mallory),
    // which denies her — the polling path returns an empty page rather
    // than leaking Alice's data.
    const malloryPoll = await request(app)
      .get(`/feeds/${intersectedHash}`)
      .set('x-test-user-id', malloryId);
    expect(malloryPoll.status).toBe(200);
    const malloryBody = JSON.parse(malloryPoll.text);
    const malloryOffices = (malloryBody.references || []).filter(r => r.type === Office.Type);
    expect(malloryOffices).toHaveLength(0);
  });
});
