const request = require('supertest');
const { buildModel, User, SpecificationParser, SpecificationOf } = require('jinaga');
const { createSubscriptionApp, asUser, randomSuffix } = require('./subscription-helpers');

// jinaga.js #426: a label declared inside a negative condition and declared
// again by a child specification. Chapter 12's list of servers uses `sr` for
// both the ServerRehired and the ServerRate. Through jinaga 6.16.1, buildFeeds
// joined both into one feed that declared `sr` twice. QueryDescriptionBuilder
// keys known facts by label name, so the SQL for that feed either threw
// (`Type mismatch: Rate is compared to Rehired`, with `!E { next }`) or asked
// the Rehired fact to also be the server's Rate, and returned no rows (without
// it). A replica subscribed through this server got no rates for a rehired
// server. jinaga 6.16.2 renames the repeated label before building feeds.

jest.setTimeout(30000);

class Restaurant {
  static Type = "RepeatedLabel.Restaurant";
  type = Restaurant.Type;
  constructor(creator, identifier) {
    this.creator = creator;
    this.identifier = identifier;
  }
}

class Server {
  static Type = "RepeatedLabel.Server";
  type = Server.Type;
  constructor(restaurant, name) {
    this.restaurant = restaurant;
    this.name = name;
  }
}

class Terminated {
  static Type = "RepeatedLabel.Server.Terminated";
  type = Terminated.Type;
  constructor(server) {
    this.server = server;
  }
}

class Rehired {
  static Type = "RepeatedLabel.Server.Rehired";
  type = Rehired.Type;
  constructor(terminated) {
    this.terminated = terminated;
  }
}

class Rate {
  static Type = "RepeatedLabel.Server.Rate";
  type = Rate.Type;
  constructor(server, value, prior) {
    this.server = server;
    this.value = value;
    this.prior = prior;
  }
}

const model = buildModel(b => b
  .type(User)
  .type(Restaurant, m => m.predecessor("creator", User))
  .type(Server, m => m.predecessor("restaurant", Restaurant))
  .type(Terminated, m => m.predecessor("server", Server))
  .type(Rehired, m => m.predecessor("terminated", Terminated))
  .type(Rate, m => m
    .predecessor("server", Server)
    .predecessor("prior", Rate))
);

function authorization(a) {
  return a.any(User).any(Restaurant).any(Server).any(Terminated).any(Rehired).any(Rate);
}

// The servers of a restaurant that are employed (never terminated, or
// rehired after termination), each with its rates. The child reuses `sr`,
// which the negative condition already declares.
function listOfServersText(withCurrentRate) {
  const currentRate = withCurrentRate
    ? `\n            !E {\n                next: ${Rate.Type} [\n                    next->prior: ${Rate.Type} = sr\n                ]\n            }`
    : ``;
  return `(r: ${Restaurant.Type}) {\n` +
    `    s: ${Server.Type} [\n` +
    `        s->restaurant: ${Restaurant.Type} = r\n` +
    `        !E {\n` +
    `            st: ${Terminated.Type} [\n` +
    `                st->server: ${Server.Type} = s\n` +
    `                !E {\n` +
    `                    sr: ${Rehired.Type} [\n` +
    `                        sr->terminated: ${Terminated.Type} = st\n` +
    `                    ]\n` +
    `                }\n` +
    `            ]\n` +
    `        }\n` +
    `    ]\n` +
    `} => {\n` +
    `    rates = {\n` +
    `        sr: ${Rate.Type} [\n` +
    `            sr->server: ${Server.Type} = s${currentRate}\n` +
    `        ]\n` +
    `    } => sr\n` +
    `}`;
}

function parse(text) {
  const parser = new SpecificationParser(text);
  parser.skipWhitespace();
  return parser.parseSpecification();
}

function withEveryone(withCurrentRate) {
  return d => d
    .share(new SpecificationOf(parse(listOfServersText(withCurrentRate))))
    .withEveryone();
}

// Subscribe to the specification and read every page of every feed, as a
// replica would, returning the hashes of the facts delivered.
async function deliveredHashes(app, userId, restaurantHash, withCurrentRate) {
  const text = `let r: ${Restaurant.Type} = #${restaurantHash}\n` + listOfServersText(withCurrentRate);
  const feedsResponse = await request(app)
    .post('/feeds')
    .set('Content-Type', 'text/plain')
    .set('x-test-user-id', userId)
    .send(text);
  expect(feedsResponse.status).toBe(200);
  const { feeds } = JSON.parse(feedsResponse.text);
  expect(feeds.length).toBeGreaterThan(0);

  const hashes = new Set();
  for (const feed of feeds) {
    let bookmark = '';
    for (;;) {
      const pollResponse = await request(app)
        .get(`/feeds/${feed}`)
        .query(bookmark ? { b: bookmark } : {})
        .set('x-test-user-id', userId);
      expect(pollResponse.status).toBe(200);
      const body = JSON.parse(pollResponse.text);
      const references = body.references || [];
      references.forEach(reference => hashes.add(reference.hash));
      if (references.length === 0 || body.bookmark === bookmark) break;
      bookmark = body.bookmark;
    }
  }
  return hashes;
}

describe.each([
  ['with !E { next }', true],
  ['without !E { next }', false]
])('Feeds of a specification that reuses a label (%s)', (_, withCurrentRate) => {
  describe.each([
    ['no distribution rules', undefined],
    ['a share rule with everyone over the specification', withEveryone(withCurrentRate)]
  ])('under %s', (__, distribution) => {
    let app, withSession, close;
    let userId, restaurantHash;
    let rehiredRateHash, employedRateHash;

    beforeEach(async () => {
      ({ app, withSession, close } = await createSubscriptionApp({
        model, authorization, ...(distribution ? { distribution } : {})
      }));

      userId = 'repeated-label-' + randomSuffix();
      ({ restaurantHash, rehiredRateHash, employedRateHash } = await asUser(withSession, userId, async (j) => {
        const { userFact } = await j.login();
        const restaurant = await j.fact(new Restaurant(userFact, 'r-' + randomSuffix()));

        const rehired = await j.fact(new Server(restaurant, 'rehired'));
        const terminated = await j.fact(new Terminated(rehired));
        await j.fact(new Rehired(terminated));
        const rehiredRate = await j.fact(new Rate(rehired, 20, []));

        const employed = await j.fact(new Server(restaurant, 'employed'));
        const employedRate = await j.fact(new Rate(employed, 18, []));

        return {
          restaurantHash: j.hash(restaurant),
          rehiredRateHash: j.hash(rehiredRate),
          employedRateHash: j.hash(employedRate)
        };
      }));
    });

    afterEach(async () => {
      if (close) await close();
    });

    it('delivers the rate of a rehired server', async () => {
      const hashes = await deliveredHashes(app, userId, restaurantHash, withCurrentRate);
      expect(hashes.has(rehiredRateHash)).toBe(true);
    });

    it('delivers the rate of a server never terminated', async () => {
      const hashes = await deliveredHashes(app, userId, restaurantHash, withCurrentRate);
      expect(hashes.has(employedRateHash)).toBe(true);
    });
  });
});
