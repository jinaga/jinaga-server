const request = require('supertest');
const { buildModel, User } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// Exercises a PostgresStore feed-SQL bug surfaced by the Copilot review
// on PR #164: when a path condition inside an existential references a
// given for the first time, the type+hash filter for that given is
// registered on `ExistentialConditionDescription.inputs`. The result-SQL
// generator emits those, but the feed-SQL generator silently drops them.
// The effect is a notExists that ignores its parameterized filter — the
// existential matches ANY fact with the right roles regardless of the
// given's identity, so the outer match is filtered out incorrectly.

jest.setTimeout(30000);

class Workspace {
  static Type = "ExistInput.Workspace";
  type = Workspace.Type;
  constructor(creator, name) {
    this.creator = creator;
    this.name = name;
  }
}

class WorkspaceAccess {
  static Type = "ExistInput.WorkspaceAccess";
  type = WorkspaceAccess.Type;
  constructor(workspace, user) {
    this.workspace = workspace;
    this.user = user;
  }
}

class Document {
  static Type = "ExistInput.Document";
  type = Document.Type;
  constructor(workspace, title) {
    this.workspace = workspace;
    this.title = title;
  }
}

class Restriction {
  static Type = "ExistInput.Restriction";
  type = Restriction.Type;
  // Marks a document as hidden from a specific user.
  constructor(document, user) {
    this.document = document;
    this.user = user;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Workspace, m => m.predecessor("creator", User))
  .type(WorkspaceAccess, m => m
    .predecessor("workspace", Workspace)
    .predecessor("user", User))
  .type(Document, m => m.predecessor("workspace", Workspace))
  .type(Restriction, m => m
    .predecessor("document", Document)
    .predecessor("user", User))
);

function authorization(a) {
  return a
    .any(User)
    .any(Workspace)
    .any(WorkspaceAccess)
    .any(Document)
    .any(Restriction);
}

// 2-given rule whose share has the SAME shape as the user's spec
// (documents in workspace w, except those restricted for user u).
// The `with` rule grants access to any user that has a
// WorkspaceAccess for the workspace. The rule's share spec is what
// has to skeleton-match the user's spec for canDistributeTo to pass.
function distribution(d) {
  return d
    .share(model.given(Workspace, User).match((w, u, facts) =>
      facts.ofType(Document).join(d => d.workspace, w)
        .notExists(d => facts.ofType(Restriction)
          .join(r => r.document, d)
          .join(r => r.user, u))
    ))
    .with(model.given(Workspace, User).match((w, u, facts) =>
      facts.ofType(WorkspaceAccess)
        .join(a => a.workspace, w)
        .join(a => a.user, u)
        .selectMany(a => facts.ofType(User).join(x => x, a.user))
    ));
}

// Subscription: documents in workspace p1 that have not been
// restricted for user p2. The given p2 is referenced FOR THE
// FIRST TIME inside the notExists — this is what triggers the
// "existential inputs dropped" bug in the feed-SQL generator.
function docSpecText(workspaceHash, userHash) {
  return `let p1: ${Workspace.Type} = #${workspaceHash}\n` +
    `let p2: ${User.Type} = #${userHash}\n` +
    `(p1: ${Workspace.Type}, p2: ${User.Type}) {\n` +
    `    d: ${Document.Type} [\n` +
    `        d->workspace: ${Workspace.Type} = p1\n` +
    `        !E {\n` +
    `            r: ${Restriction.Type} [\n` +
    `                r->document: ${Document.Type} = d\n` +
    `                r->user: ${User.Type} = p2\n` +
    `            ]\n` +
    `        }\n` +
    `    ]\n` +
    `} => d`;
}

describe('Feed SQL: existential references a given referenced only inside the notExists', () => {
  let app, withSession, close;
  let workspaceValue, workspaceHash, documentValue, documentHash;
  let creatorId;

  beforeEach(async () => {
    ({ app, withSession, close } = await createSubscriptionApp({
      model, authorization, distribution
    }));

    creatorId = 'ei-creator-' + randomSuffix();
    ({ workspaceHash, documentHash } = await asUser(withSession, creatorId, async (j) => {
      const { userFact: creatorFact } = await j.login();
      const workspace = await j.fact(new Workspace(creatorFact, 'w-' + randomSuffix()));
      workspaceValue = workspace;
      const document = await j.fact(new Document(workspace, 'doc-' + randomSuffix()));
      documentValue = document;
      return {
        workspaceHash: j.hash(workspace),
        documentHash: j.hash(document)
      };
    }));
  });

  afterEach(async () => {
    if (close) await close();
  });

  it('does not let one user\'s Restriction hide a document from a different user', async () => {
    // Alice and Bob both get WorkspaceAccess so the distribution
    // check passes for each of them directly (no intersection).
    const aliceId = 'ei-alice-' + randomSuffix();
    const aliceFact = await asUser(withSession, aliceId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    const bobId = 'ei-bob-' + randomSuffix();
    const bobFact = await asUser(withSession, bobId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    await asUser(withSession, creatorId, async (j) => {
      await j.fact(new WorkspaceAccess(workspaceValue, aliceFact));
      await j.fact(new WorkspaceAccess(workspaceValue, bobFact));
      // Restriction targets Bob ONLY. Alice's view must not be
      // affected — her notExists should remain true.
      await j.fact(new Restriction(documentValue, bobFact));
    });

    const aliceHash = await asUser(withSession, aliceId, async (j) => j.hash(aliceFact));

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', aliceId)
      .send(docSpecText(workspaceHash, aliceHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);
    expect(feeds.length).toBeGreaterThan(0);

    // A spec with notExists splits into a negating feed and a main
    // feed (with the notExists applied). The bug lives in the main
    // feed's SQL, so aggregate references across all feeds.
    const aggregated = [];
    for (const feedHash of feeds) {
      const pollResponse = await request(app)
        .get(`/feeds/${feedHash}`)
        .set('x-test-user-id', aliceId);
      expect(pollResponse.status).toBe(200);
      const body = JSON.parse(pollResponse.text);
      aggregated.push(...(body.references || []));
    }
    const docs = aggregated.filter(r => r.type === Document.Type);
    // Without the fix the main feed's existential ignores its
    // `user = p2` filter and matches Bob's Restriction, so Alice's
    // notExists evaluates false and she gets no documents.
    expect(docs.map(r => r.hash)).toContain(documentHash);
  });

  it('hides a document from the user whose Restriction exists', async () => {
    // Companion case: when the Restriction IS for the polling user,
    // the notExists must evaluate false and the document must be
    // filtered out.
    const carolId = 'ei-carol-' + randomSuffix();
    const carolFact = await asUser(withSession, carolId, async (j) => {
      const { userFact } = await j.login();
      return userFact;
    });

    await asUser(withSession, creatorId, async (j) => {
      await j.fact(new WorkspaceAccess(workspaceValue, carolFact));
      await j.fact(new Restriction(documentValue, carolFact));
    });

    const carolHash = await asUser(withSession, carolId, async (j) => j.hash(carolFact));

    const feedsResponse = await request(app)
      .post('/feeds')
      .set('Content-Type', 'text/plain')
      .set('x-test-user-id', carolId)
      .send(docSpecText(workspaceHash, carolHash));
    expect(feedsResponse.status).toBe(200);
    const { feeds } = JSON.parse(feedsResponse.text);

    // The main feed must NOT include the document for Carol. The
    // negating feed legitimately surfaces the Restriction (a fact
    // proving the condition false) along with the Document so the
    // client can react — exclude those by only counting Documents
    // returned without an accompanying Restriction.
    let mainDocHashes = [];
    for (const feedHash of feeds) {
      const pollResponse = await request(app)
        .get(`/feeds/${feedHash}`)
        .set('x-test-user-id', carolId);
      expect(pollResponse.status).toBe(200);
      const body = JSON.parse(pollResponse.text);
      const refs = body.references || [];
      const hasRestriction = refs.some(r => r.type === Restriction.Type);
      if (!hasRestriction) {
        mainDocHashes.push(...refs.filter(r => r.type === Document.Type).map(r => r.hash));
      }
    }
    expect(mainDocHashes).not.toContain(documentHash);
  });
});
