const request = require('supertest');
const { buildModel, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Validates the "keep subscriptions alive across distribution failures"
// contract: when no distribution rule covers the requested spec, the
// /feeds endpoint accepts the subscription and polling returns an empty
// page rather than 403. /read still 403s because reads are one-shot.

class Company {
  static Type = "NoRule.Company";
  type = Company.Type;
  constructor(creator, identifier) {
    this.creator = creator;
    this.identifier = identifier;
  }
}

class Office {
  static Type = "NoRule.Office";
  type = Office.Type;
  constructor(company, name) {
    this.company = company;
    this.name = name;
  }
}

class Administrator {
  static Type = "NoRule.Administrator";
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

// Distribution covers Office only. Administrator queries fall outside
// any rule.
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

function administratorSpecText(companyHash) {
  return `let p1: ${Company.Type} = #${companyHash}\n` +
    `(p1: ${Company.Type}) {\n` +
    `    a: ${Administrator.Type} [\n` +
    `        a->company: ${Company.Type} = p1\n` +
    `    ]\n` +
    `} => a`;
}

describe('Subscription when no distribution rule applies', () => {
  let app, withSession, close;
  let companyHash;
  let subscriberId;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization, distribution
    }));

    const creatorId = 'creator-norule-' + randomSuffix();
    ({ companyHash } = await asUser(withSession, creatorId, async (creatorJ) => {
      const { userFact: creatorFact } = await creatorJ.login();
      const company = await creatorJ.fact(new Company(creatorFact, 'Acme-' + randomSuffix()));
      return { companyHash: creatorJ.hash(company) };
    }));

    subscriberId = 'subscriber-norule-' + randomSuffix();
    await asUser(withSession, subscriberId, async (j) => { await j.login(); });
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('accepts /feeds and returns an empty page on poll', async () => {
    // No rule covers Administrator. intersectForSubscribe also has
    // nothing to intersect against. The contract is: /feeds succeeds,
    // polling returns an empty page so the client keeps waiting.
    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(administratorSpecText(companyHash));

    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);
    expect(Array.isArray(feeds)).toBe(true);
    expect(feeds.length).toBeGreaterThan(0);

    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', subscriberId);
    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    expect(body.references || []).toEqual([]);
  });

  it('still returns 403 from /read for the same spec', async () => {
    // Reads are one-shot — there is no "wait until authorized later"
    // semantic, so Forbidden propagates as 403.
    const readResponse = await request(app)
      .post('/read')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', subscriberId)
      .send(administratorSpecText(companyHash));

    expect(readResponse.status).toBe(403);
  });
});
