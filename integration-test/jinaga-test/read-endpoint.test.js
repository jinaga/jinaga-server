const request = require('supertest');
const { JinagaServer } = require('./jinaga-server');
const express = require('express');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Test model classes
class Root {
  static Type = "ReadTest.Root";
  type = Root.Type;

  constructor(identifier) {
    this.identifier = identifier;
  }
}

class Successor {
  static Type = "ReadTest.Successor";
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

// Helper to create test data
async function createTestData(j, count) {
  const root = await j.fact(new Root(Math.random().toString(36).substring(2, 10)));
  const successors = [];
  
  for (let i = 0; i < count; i++) {
    const successor = await j.fact(new Successor(`successor-${i}`, root));
    successors.push(successor);
  }
  
  return { root, successors };
}

// Helper to parse NDJSON
function parseNDJSON(text) {
  return text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
}

describe('Read Endpoint - Phase 1: Content Negotiation', () => {
  let app;
  let j;
  let close;
  let root;
  let rootHash;
  let successors;

  beforeEach(async () => {
    ({ app, j, close } = await createTestApp());
    await j.local();
    
    // Create test data: 1 Root and 2 Successors
    ({ root, successors } = await createTestData(j, 2));
    rootHash = j.hash(root);
  });

  afterEach(async () => {
    if (close) {
      await close();
    }
  });

  describe('1.1: Default JSON Response (Backward Compatibility)', () => {
    it('should return pretty-printed JSON array with default Accept header', async () => {
      const specification = `let root: ReadTest.Root = #${rootHash}

(root: ReadTest.Root) {
  s: ReadTest.Successor [
    s->pred: ReadTest.Root = root
  ]
} => {
  successor = s
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .send(specification);

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      expect(response.type).toBe('text/plain');
      
      // Parse the response
      const results = JSON.parse(response.text);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      
      // Check that response is pretty-printed (has whitespace)
      expect(response.text).toContain('\n');
      expect(response.text).toContain('  '); // 2-space indentation
    });
  });

  describe('1.2: Compact JSON Response', () => {
    it('should return compact JSON when Accept: application/json', async () => {
      const specification = `let root: ReadTest.Root = #${rootHash}

(root: ReadTest.Root) {
  s: ReadTest.Successor [
    s->pred: ReadTest.Root = root
  ]
} => {
  successor = s
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/json')
        .send(specification);

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      expect(response.type).toBe('application/json');
      
      // Parse the response
      const results = JSON.parse(response.text);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      
      // Check that response is compact (minimal whitespace)
      // Compact JSON should not have formatting newlines or multiple spaces
      const withoutData = response.text.replace(/"[^"]*"/g, '""'); // Remove string contents
      expect(withoutData).not.toContain('\n  ');
    });
  });

  describe('1.3: Pretty JSON for Debugging', () => {
    it('should return pretty JSON when Accept: text/plain', async () => {
      const specification = `let root: ReadTest.Root = #${rootHash}

(root: ReadTest.Root) {
  s: ReadTest.Successor [
    s->pred: ReadTest.Root = root
  ]
} => {
  successor = s
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/plain')
        .send(specification);

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      expect(response.type).toBe('text/plain');
      
      // Parse the response
      const results = JSON.parse(response.text);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(2);
      
      // Check 2-space indentation
      const lines = response.text.split('\n');
      const indentedLines = lines.filter(line => line.startsWith('  '));
      expect(indentedLines.length).toBeGreaterThan(0);
    });
  });

  describe('1.4: NDJSON Format', () => {
    it('should return newline-delimited JSON when Accept: application/x-ndjson', async () => {
      // Create 5 successors for this test
      await j.fact(new Successor(`successor-2`, root));
      await j.fact(new Successor(`successor-3`, root));
      await j.fact(new Successor(`successor-4`, root));

      const specification = `let root: ReadTest.Root = #${rootHash}

(root: ReadTest.Root) {
  s: ReadTest.Successor [
    s->pred: ReadTest.Root = root
  ]
} => {
  successor = s
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(specification);

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      expect(response.type).toBe('application/x-ndjson');
      
      // Parse NDJSON response
      const results = parseNDJSON(response.text);
      expect(results.length).toBe(5);
      
      // Each line should be valid JSON
      results.forEach(item => {
        expect(item).toHaveProperty('s');
      });
    });
  });

  describe('1.5: OPTIONS Endpoint Update', () => {
    it('should return supported content types in OPTIONS response', async () => {
      const response = await request(app)
        .options('/read');

      expect(response.status).toBe(204);
      
      const acceptPost = response.headers['accept-post'];
      expect(acceptPost).toBeDefined();
      expect(acceptPost).toContain('text/plain');
      
      // After implementation, should also include:
      // expect(acceptPost).toContain('application/json');
      // expect(acceptPost).toContain('application/x-ndjson');
    });
  });

  describe('1.6: Large Result Set', () => {
    it('should handle 1000 results with all formats', async () => {
      // Create 1000 successors
      const largeRoot = await j.fact(new Root('large-test-' + Date.now()));
      const largeRootHash = j.hash(largeRoot);
      
      // Create in batches to avoid memory issues
      for (let i = 0; i < 1000; i++) {
        await j.fact(new Successor(`large-successor-${i}`, largeRoot));
      }

      const specification = `let root: ReadTest.Root = #${largeRootHash}

(root: ReadTest.Root) {
  s: ReadTest.Successor [
    s->pred: ReadTest.Root = root
  ]
} => {
  successor = s
}`;

      // Test with application/json
      const jsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/json')
        .send(specification);

      if (jsonResponse.status !== 200) {
        expect(jsonResponse.text).toBe('');
        expect(jsonResponse.status).toBe(200);
      }
      expect(jsonResponse.status).toBe(200);
      const jsonResults = JSON.parse(jsonResponse.text);
      expect(jsonResults.length).toBe(1000);

      // Test with text/plain
      const plainResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/plain')
        .send(specification);

      if (plainResponse.status !== 200) {
        expect(plainResponse.text).toBe('');
        expect(plainResponse.status).toBe(200);
      }
      expect(plainResponse.status).toBe(200);
      const plainResults = JSON.parse(plainResponse.text);
      expect(plainResults.length).toBe(1000);

      // Test with application/x-ndjson
      const ndjsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(specification);

      if (ndjsonResponse.status !== 200) {
        expect(ndjsonResponse.text).toBe('');
        expect(ndjsonResponse.status).toBe(200);
      }
      expect(ndjsonResponse.status).toBe(200);
      const ndjsonResults = parseNDJSON(ndjsonResponse.text);
      expect(ndjsonResults.length).toBe(1000);
    }, 60000); // 60 second timeout for large dataset
  });
});
