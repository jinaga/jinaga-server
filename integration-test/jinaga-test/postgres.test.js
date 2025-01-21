const { Pool } = require('pg');
const { PostgresStore } = require('./jinaga-server');

const host = "db";
// const host = "localhost";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

const pool = new Pool({
  connectionString
});

describe('PostgresStore bookmarks', () => {
  let store;

  beforeAll(async () => {
    store = new PostgresStore(pool, 'public');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should save and load a bookmark', async () => {
    const feed = 'test-feed';
    const bookmark = JSON.stringify([1, 2, 3]);

    await store.saveBookmark(feed, bookmark);
    const loadedBookmark = await store.loadBookmark(feed);

    expect(loadedBookmark).toEqual(bookmark);
  });

  it('should return an empty string for a non-existent bookmark', async () => {
    const feed = 'non-existent-feed';
    const loadedBookmark = await store.loadBookmark(feed);

    expect(loadedBookmark).toEqual('');
  });
});
