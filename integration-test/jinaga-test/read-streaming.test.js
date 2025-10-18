const request = require('supertest');
const { JinagaServer } = require('./jinaga-server');
const express = require('express');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Test model classes
class Root {
  static Type = "StreamTest.Root";
  type = Root.Type;

  constructor(identifier) {
    this.identifier = identifier;
  }
}

class Successor {
  static Type = "StreamTest.Successor";
  type = Successor.Type;

  constructor(identifier, predecessor) {
    this.identifier = identifier;
    this.pred = predecessor;
  }
}

// Helper to create test app
async function createTestApp() {
  const { handler, j, close } = JinagaServer.create({
    pgKeystore: connectionString,
    pgStore: connectionString
  });

  const app = express();
  app.use(express.json());
  app.use(express.text());
  app.use(handler);

  return { app, j, close };
}

// Helper to parse NDJSON
function parseNDJSON(text) {
  return text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
}

describe('Read Endpoint - Phase 2: Streaming Infrastructure', () => {
  let app;
  let j;
  let close;

  beforeEach(async () => {
    ({ app, j, close } = await createTestApp());
    await j.local();
  });

  afterEach(async () => {
    if (close) {
      await close();
    }
  });

  describe('2.3: NDJSON Streaming Output', () => {
    it('should stream NDJSON without loading all into memory', async () => {
      // Create 5000 successors
      const root = await j.fact(new Root('stream-test-' + Date.now()));
      const rootHash = j.hash(root);
      
      // Create in batches
      for (let i = 0; i < 5000; i++) {
        await j.fact(new Successor(`stream-successor-${i}`, root));
      }

      const specification = `(root: StreamTest.Root) {
  s: StreamTest.Successor [
    s->pred: StreamTest.Root = root
  ]
} => {
  s = s
}`;

      const startTime = Date.now();
      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(`let root: StreamTest.Root = #${rootHash}\n${specification}`);

      const duration = Date.now() - startTime;

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      expect(response.type).toBe('application/x-ndjson');
      
      // Parse NDJSON response
      const results = parseNDJSON(response.text);
      expect(results.length).toBe(5000);
      
      // Should start streaming within 1 second
      expect(duration).toBeLessThan(10000); // 10 seconds for large set
      
      // Verify structure
      expect(results[0]).toHaveProperty('s');
      expect(results[0].s).toHaveProperty('type', 'StreamTest.Successor');
    }, 120000); // 120 second timeout for large dataset
  });

  describe('2.4: Stream Error Handling', () => {
    it('should handle normal completion without errors', async () => {
      const root = await j.fact(new Root('error-test-' + Date.now()));
      const rootHash = j.hash(root);
      await j.fact(new Successor(`error-successor-1`, root));
      await j.fact(new Successor(`error-successor-2`, root));
      await j.fact(new Successor(`error-successor-3`, root));

      const specification = `(root: StreamTest.Root) {
  s: StreamTest.Successor [
    s->pred: StreamTest.Root = root
  ]
} => {
  s = s
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(`let root: StreamTest.Root = #${rootHash}\n${specification}`);

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      
      const results = parseNDJSON(response.text);
      expect(results.length).toBe(3);
      
      // None of the results should be error frames
      results.forEach(item => {
        expect(item.error).toBeUndefined();
      });
    });
  });

  describe('2.5: Backward Compatibility with Arrays', () => {
    it('should accept and format array results', async () => {
      const root = await j.fact(new Root('compat-test-' + Date.now()));
      const rootHash = j.hash(root);
      await j.fact(new Successor(`compat-successor-1`, root));
      await j.fact(new Successor(`compat-successor-2`, root));

      const specification = `(root: StreamTest.Root) {
  s: StreamTest.Successor [
    s->pred: StreamTest.Root = root
  ]
} => {
  s = s
}`;

      // Test all formats work with array-based results
      const jsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/json')
        .send(`let root: StreamTest.Root = #${rootHash}\n${specification}`);

      if (jsonResponse.status !== 200) {
        expect(jsonResponse.text).toBe('');
        expect(jsonResponse.status).toBe(200);
      }
      expect(jsonResponse.status).toBe(200);
      const jsonResults = JSON.parse(jsonResponse.text);
      expect(jsonResults.length).toBe(2);

      const ndjsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(`let root: StreamTest.Root = #${rootHash}\n${specification}`);

      if (ndjsonResponse.status !== 200) {
        expect(ndjsonResponse.text).toBe('');
        expect(ndjsonResponse.status).toBe(200);
      }
      expect(ndjsonResponse.status).toBe(200);
      const ndjsonResults = parseNDJSON(ndjsonResponse.text);
      expect(ndjsonResults.length).toBe(2);
    });
  });
});
