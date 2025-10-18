const request = require('supertest');
const { JinagaServer } = require('./jinaga-server');
const express = require('express');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Test model classes
class Root {
  static Type = "PerfTest.Root";
  type = Root.Type;

  constructor(identifier) {
    this.identifier = identifier;
  }
}

class Successor {
  static Type = "PerfTest.Successor";
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

// Helper to measure memory
function getMemoryUsage() {
  return process.memoryUsage().heapUsed / 1024 / 1024; // MB
}

describe('Read Endpoint - Performance Benchmarks', () => {
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

  describe('Performance: 1000 results', () => {
    it('should complete within reasonable time', async () => {
      const root = await j.fact(new Root('perf-1k-' + Date.now()));
      const rootHash = j.hash(root);
      
      for (let i = 0; i < 1000; i++) {
        await j.fact(new Successor(`perf-successor-${i}`, root));
      }

      const specification = `let root: PerfTest.Root = #${rootHash}

(root: PerfTest.Root) {
  s: PerfTest.Successor [
    s->pred: PerfTest.Root = root
  ]
} => {
  successor = s
}`;

      const startTime = Date.now();
      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/json')
        .send(specification);

      const duration = Date.now() - startTime;

      if (response.status !== 200) {
        expect(response.text).toBe('');
        expect(response.status).toBe(200);
      }
      expect(response.status).toBe(200);
      const results = JSON.parse(response.text);
      expect(results.length).toBe(1000);
      
      console.log(`1000 results completed in ${duration}ms`);
      expect(duration).toBeLessThan(30000); // 30 seconds
    }, 60000);
  });

  describe('Performance: NDJSON vs JSON', () => {
    it('should measure time to first byte for NDJSON', async () => {
      const root = await j.fact(new Root('perf-ttfb-' + Date.now()));
      const rootHash = j.hash(root);
      
      for (let i = 0; i < 100; i++) {
        await j.fact(new Successor(`perf-successor-${i}`, root));
      }

      const specification = `let root: PerfTest.Root = #${rootHash}

(root: PerfTest.Root) {
  s: PerfTest.Successor [
    s->pred: PerfTest.Root = root
  ]
} => {
  successor = s
}`;

      // Test NDJSON
      const ndjsonStart = Date.now();
      const ndjsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/x-ndjson')
        .send(specification);
      const ndjsonDuration = Date.now() - ndjsonStart;

      if (ndjsonResponse.status !== 200) {
        expect(ndjsonResponse.text).toBe('');
        expect(ndjsonResponse.status).toBe(200);
      }
      expect(ndjsonResponse.status).toBe(200);
      const ndjsonResults = parseNDJSON(ndjsonResponse.text);
      expect(ndjsonResults.length).toBe(100);

      // Test JSON
      const jsonStart = Date.now();
      const jsonResponse = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'application/json')
        .send(specification);
      const jsonDuration = Date.now() - jsonStart;

      if (jsonResponse.status !== 200) {
        expect(jsonResponse.text).toBe('');
        expect(jsonResponse.status).toBe(200);
      }
      expect(jsonResponse.status).toBe(200);
      const jsonResults = JSON.parse(jsonResponse.text);
      expect(jsonResults.length).toBe(100);

      console.log(`NDJSON: ${ndjsonDuration}ms, JSON: ${jsonDuration}ms`);
    }, 60000);
  });

  describe('Concurrent streams', () => {
    it('should handle multiple concurrent requests', async () => {
      const root = await j.fact(new Root('perf-concurrent-' + Date.now()));
      const rootHash = j.hash(root);
      
      for (let i = 0; i < 100; i++) {
        await j.fact(new Successor(`perf-successor-${i}`, root));
      }

      const specification = `let root: PerfTest.Root = #${rootHash}

(root: PerfTest.Root) {
  s: PerfTest.Successor [
    s->pred: PerfTest.Root = root
  ]
} => {
  successor = s
}`;

      // Launch 5 concurrent requests
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          request(app)
            .post('/read')
            .set('Content-Type', 'text/plain')
            .set('Accept', 'application/x-ndjson')
            .send(specification)
        );
      }

      const startTime = Date.now();
      const responses = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All should succeed
      responses.forEach(response => {
        if (response.status !== 200) {
          expect(response.text).toBe('');
          expect(response.status).toBe(200);
        }
        expect(response.status).toBe(200);
        const results = parseNDJSON(response.text);
        expect(results.length).toBe(100);
      });

      console.log(`5 concurrent requests completed in ${duration}ms`);
      expect(duration).toBeLessThan(30000); // 30 seconds
    }, 60000);
  });
});
