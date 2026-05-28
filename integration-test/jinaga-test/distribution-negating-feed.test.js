const request = require('supertest');
const { buildModel, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Exercises a distribution rule whose user-spec uses notExists — the
// "negating-feed authorization (#196)" dimension the PR closes by
// having DistributionEngine.canDistributeTo fall back to
// canAuthorizeByComposition. We avoid the late-auth/intersection path
// here so the test is hitting canDistributeTo (via feedWithDistribution)
// directly with a negating user-spec.

jest.setTimeout(30000);

class Group {
  static Type = "NegatingFeed.Group";
  type = Group.Type;
  constructor(creator, name) {
    this.creator = creator;
    this.name = name;
  }
}

class Member {
  static Type = "NegatingFeed.Member";
  type = Member.Type;
  constructor(group, user) {
    this.group = group;
    this.user = user;
  }
}

class MemberRemoved {
  static Type = "NegatingFeed.Member.Removed";
  type = MemberRemoved.Type;
  constructor(member) {
    this.member = member;
  }
}

class Content {
  static Type = "NegatingFeed.Content";
  type = Content.Type;
  constructor(group, body) {
    this.group = group;
    this.body = body;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Group, m => m.predecessor("creator", User))
  .type(Member, m => m
    .predecessor("group", Group)
    .predecessor("user", User))
  .type(MemberRemoved, m => m.predecessor("member", Member))
  .type(Content, m => m.predecessor("group", Group))
);

function authorization(a) {
  return a
    .any(User)
    .any(Group)
    .any(Member)
    .any(MemberRemoved)
    .any(Content);
}

// Share Content of a Group with users who are currently Members — i.e.
// have a Member fact with no MemberRemoved successor. The notExists
// here is what makes this a "negating-feed" user-spec.
function distribution(d) {
  return d
    .share(model.given(Group).match((g, facts) =>
      facts.ofType(Content).join(c => c.group, g)
    ))
    .with(model.given(Group).match((g, facts) =>
      facts.ofType(Member)
        .join(m => m.group, g)
        .notExists(m => facts.ofType(MemberRemoved).join(r => r.member, m))
        .selectMany(m => facts.ofType(User).join(u => u, m.user))
    ));
}

function contentSpecText(groupHash) {
  return `let p1: ${Group.Type} = #${groupHash}\n` +
    `(p1: ${Group.Type}) {\n` +
    `    c: ${Content.Type} [\n` +
    `        c->group: ${Group.Type} = p1\n` +
    `    ]\n` +
    `} => c`;
}

describe('Distribution rule with negating feed (notExists)', () => {
  let app, withSession, close;
  let groupValue, groupHash, contentHash;
  let creatorId;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization, distribution
    }));

    creatorId = 'group-creator-' + randomSuffix();
    ({ groupHash, contentHash } = await asUser(withSession, creatorId, async (creatorJ) => {
      const { userFact: creatorFact } = await creatorJ.login();
      const group = await creatorJ.fact(new Group(creatorFact, 'g-' + randomSuffix()));
      groupValue = group;
      const content = await creatorJ.fact(new Content(group, 'shared body'));
      return {
        groupHash: creatorJ.hash(group),
        contentHash: creatorJ.hash(content)
      };
    }));
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('delivers content to a current member', async () => {
    const memberId = 'group-member-' + randomSuffix();
    const memberFact = await asUser(withSession, memberId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    // Grant membership BEFORE subscribing so the distribution check
    // (notExists removed → current member) passes and we never hit
    // intersection. This makes the test target canDistributeTo
    // directly via feedWithDistribution.
    await asUser(withSession, creatorId, async (j) => {
      await j.fact(new Member(groupValue, memberFact));
    });

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', memberId)
      .send(contentSpecText(groupHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);

    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', memberId);
    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    const visible = (body.references || []).filter(r => r.type === Content.Type);
    expect(visible.map(r => r.hash)).toContain(contentHash);
  });

  it('hides content from a removed member', async () => {
    const memberId = 'group-removed-' + randomSuffix();
    const memberFact = await asUser(withSession, memberId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    // Add then remove the membership. The notExists branch flips,
    // canDistributeTo denies, and the poll returns an empty page.
    let memberValue;
    await asUser(withSession, creatorId, async (j) => {
      memberValue = await j.fact(new Member(groupValue, memberFact));
      await j.fact(new MemberRemoved(memberValue));
    });

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', memberId)
      .send(contentSpecText(groupHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);

    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', memberId);
    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    expect((body.references || []).filter(r => r.type === Content.Type)).toHaveLength(0);
  });

  it('hides content from a never-member', async () => {
    const outsiderId = 'group-outsider-' + randomSuffix();
    await asUser(withSession, outsiderId, async (j) => { /* login only */ });

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', outsiderId)
      .send(contentSpecText(groupHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);

    const pollResponse = await request(app)
      .get(`/feeds/${feeds[0]}`)
      .set('x-test-user-id', outsiderId);
    expect(pollResponse.status).toBe(200);
    const body = JSON.parse(pollResponse.text);
    expect((body.references || []).filter(r => r.type === Content.Type)).toHaveLength(0);
  });
});
