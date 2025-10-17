const express = require('express');
const { JinagaServer } = require('./jinaga-server');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

/**
 * Creates an Express app with HTTP router for testing
 * @returns {Promise<{app: express.Application, close: Function}>}
 */
async function createTestApp() {
  const { handler, close } = JinagaServer.create({
    pgKeystore: connectionString,
    pgStore: connectionString
  });

  const app = express();
  app.use(express.json());
  app.use(express.text());
  app.use(handler);

  return { app, close };
}

/**
 * Creates test data with a Root and specified number of Successors
 * @param {Object} j - Jinaga instance
 * @param {Object} Root - Root class
 * @param {Object} Successor - Successor class
 * @param {number} count - Number of successors to create
 * @returns {Promise<{root: Object, successors: Array}>}
 */
async function createTestData(j, Root, Successor, count) {
  const root = await j.fact(new Root(Math.random().toString(36).substring(2, 10)));
  const successors = [];
  
  for (let i = 0; i < count; i++) {
    const successor = await j.fact(new Successor(`successor-${i}`, root));
    successors.push(successor);
  }
  
  return { root, successors };
}

/**
 * Parses NDJSON response text
 * @param {string} text - Response text in NDJSON format
 * @returns {Array} Array of parsed JSON objects
 */
function parseNDJSON(text) {
  return text
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line));
}

/**
 * Measures memory usage during function execution
 * @param {Function} fn - Async function to execute
 * @returns {Promise<{result: any, heapUsed: number}>}
 */
async function measureMemory(fn) {
  const startMemory = process.memoryUsage().heapUsed;
  const result = await fn();
  const endMemory = process.memoryUsage().heapUsed;
  const heapUsed = endMemory - startMemory;
  
  return { result, heapUsed };
}

module.exports = {
  createTestApp,
  createTestData,
  parseNDJSON,
  measureMemory
};
