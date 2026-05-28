const express = require('express');
const { JinagaServer } = require('./jinaga-server');

const host = "db";
const connectionString = `postgresql://dev:devpw@${host}:5432/integrationtest`;

function authMiddleware(req, res, next) {
  const userId = req.header('x-test-user-id');
  if (userId) {
    req.user = {
      provider: 'test',
      id: userId,
      profile: { displayName: userId }
    };
  }
  next();
}

async function createSubscriptionApp(config) {
  const instance = JinagaServer.create({
    pgKeystore: connectionString,
    pgStore: connectionString,
    ...config
  });

  const app = express();
  app.use(express.json());
  app.use(express.text());
  app.use(authMiddleware);
  app.use(instance.handler);

  await instance.j.local();
  return { app, ...instance };
}

async function asUser(withSession, userId, callback) {
  let result;
  await withSession(
    { user: { provider: 'test', id: userId, profile: { displayName: userId } } },
    async (j) => {
      // Ensure the user fact is registered in the keystore so AuthenticationSession
      // can sign facts and the router's getUserFact succeeds on later requests.
      await j.login();
      result = await callback(j);
    }
  );
  return result;
}

function randomSuffix() {
  return Math.random().toString(36).substring(2, 10);
}

module.exports = {
  connectionString,
  authMiddleware,
  createSubscriptionApp,
  asUser,
  randomSuffix
};
