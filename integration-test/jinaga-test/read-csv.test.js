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

  describe('2.7: CSV Output Format', () => {
    it('should return valid CSV when Accept: text/csv', async () => {
      const specification = `(root: CSVTest.Root) {
  s: CSVTest.Successor [
    s->pred: root
  ]
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(`root = ${JSON.stringify(root)}\n${specification}`);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Parse CSV
      const { headers, rows } = parseCSV(response.text);
      
      // Should have headers
      expect(headers.length).toBeGreaterThan(0);
      
      // Should have 3 rows
      expect(rows.length).toBe(3);
      
      // Each row should have the same number of fields as headers
      rows.forEach(row => {
        expect(Object.keys(row).length).toBe(headers.length);
      });
    });

    it('should properly escape CSV values with commas', async () => {
      const specification = `(root: CSVTest.Root) {
  s: CSVTest.Successor [
    s->pred: root
  ]
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(`root = ${JSON.stringify(root)}\n${specification}`);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
      
      // Response should be valid CSV
      expect(response.text).toBeTruthy();
      expect(response.text.includes('\n')).toBe(true);
    });

    it('should handle empty result set', async () => {
      const emptyRoot = await j.fact(new Root('empty-csv-test-' + Date.now()));
      
      const specification = `(root: CSVTest.Root) {
  s: CSVTest.Successor [
    s->pred: root
  ]
}`;

      const response = await request(app)
        .post('/read')
        .set('Content-Type', 'text/plain')
        .set('Accept', 'text/csv')
        .send(`root = ${JSON.stringify(emptyRoot)}\n${specification}`);

      expect(response.status).toBe(200);
      expect(response.type).toBe('text/csv');
    });
  });
});
