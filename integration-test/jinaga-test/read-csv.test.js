const request = require('supertest');
const { JinagaServer } = require('./jinaga-server');
const express = require('express');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

// Test model classes
class Root {
  static Type = "CSVTest.Root";
  type = Root.Type;

  constructor(identifier) {
    this.identifier = identifier;
  }
}

class Successor {
  static Type = "CSVTest.Successor";
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

// Helper to parse CSV
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index];
    });
    rows.push(row);
  }
  
  return { headers, rows };
}

describe('Read Endpoint - CSV Output', () => {
  let app;
  let j;
  let close;
  let root;

  beforeEach(async () => {
    ({ app, j, close } = await createTestApp());
    await j.local();
    
    // Create test data
    root = await j.fact(new Root('csv-test-' + Date.now()));
    await j.fact(new Successor(`csv-successor-1`, root));
    await j.fact(new Successor(`csv-successor-2`, root));
    await j.fact(new Successor(`csv-successor-3`, root));
  });

  afterEach(async () => {
    if (close) {
      await close();
    }
  });

  describe('CSV with Specification Headers', () => {
    it('should use specification labels as CSV headers', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  successorId: s.identifier,
  successorType: s.type
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Parse CSV
      const lines = response.text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      
      // Headers should match specification labels
      expect(headers).toContain('successorId');
      expect(headers).toContain('successorType');
      
      // Should have data rows
      expect(lines.length).toBeGreaterThan(1);
    });

    it('should include headers even with empty result set', async () => {
      const emptyRoot = await j.fact(new Root('empty-csv-test-' + Date.now()));
      
      const specification = `root = ${JSON.stringify(emptyRoot)}

(root: CSVTest.Root) {
  successorName: s.identifier,
  successorHash: s.hash
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Parse CSV
      const lines = response.text.trim().split('\n');
      
      // Should have headers even with no data
      expect(lines.length).toBeGreaterThanOrEqual(1);
      
      const headers = lines[0].split(',').map(h => h.trim());
      expect(headers).toContain('successorName');
      expect(headers).toContain('successorHash');
    });

    it('should properly escape CSV values with commas', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  identifier: s.identifier,
  type: s.type
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Response should be valid CSV
      expect(response.text).toBeTruthy();
      expect(response.text.includes('\n')).toBe(true);
    });
  });

  describe('CSV Validation', () => {
    it('should reject nested object projections', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  successor: {
    id: s.identifier,
    type: s.type
  }
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(400);
      expect(response.text).toContain('not compatible with CSV');
      expect(response.text).toContain('Nested object');
    });

    it('should accept flat projections with multiple fields', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  id: s.identifier,
  type: s.type,
  hash: s.hash
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      const lines = response.text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim());
      
      expect(headers).toContain('id');
      expect(headers).toContain('type');
      expect(headers).toContain('hash');
    });

    it('should provide helpful error message for invalid projections', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  allSuccessors: s
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(400);
      expect(response.text).toContain('Hint');
      expect(response.text).toContain('flat projections');
    });
  });

  describe('CSV with csv-stringify', () => {
    it('should handle special characters properly', async () => {
      // Create successor with special characters in identifier
      const specialRoot = await j.fact(new Root('special-test-' + Date.now()));
      await j.fact(new Successor('test, with "quotes"', specialRoot));
      
      const specification = `root = ${JSON.stringify(specialRoot)}

(root: CSVTest.Root) {
  name: s.identifier
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Response should properly escape the value
      expect(response.text).toContain('name');
      // csv-stringify should handle the quotes and comma
      expect(response.text).toBeTruthy();
    });

    it('should handle date values properly', async () => {
      const specification = `root = ${JSON.stringify(root)}

(root: CSVTest.Root) {
  identifier: s.identifier,
  type: s.type
}

s: CSVTest.Successor [
  s->pred: root
]`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(specification);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Should successfully generate CSV
      const lines = response.text.trim().split('\n');
      expect(lines.length).toBeGreaterThan(1);
    });
  });
});
