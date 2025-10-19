import express = require("express");
import * as http from "http";
import { JinagaServer } from "../src";
import process = require("process");
import { Trace } from "jinaga";

process.on('SIGINT', () => {
  console.log("\n\nStopping replicator\n");
  process.exit(0);
});

const app = express();
const server = http.createServer(app);

app.set('port', process.env.PORT || 8080);
// Order matters: text() before json() so text/plain endpoints work correctly
// when clients omit Content-Type headers
app.use(express.text());
app.use(express.json());

const pgConnection = process.env.JINAGA_POSTGRESQL ||
  'postgresql://appuser:apppw@localhost:5432/appdb';
const { handler } = JinagaServer.create({
  pgStore: pgConnection
});

app.use('/jinaga', handler);

// Global error handler - must be added AFTER all routes
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Log the error for debugging
  const errorDetails = {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    contentType: req.get('Content-Type')
  };
  Trace.error(`Unhandled error: ${JSON.stringify(errorDetails, null, 2)}`);

  // If headers already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Determine appropriate status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Format user-friendly error message
  let errorMessage = err.message || 'Internal Server Error';
  
  // Add context for common error types
  if (err.type === 'entity.parse.failed') {
    errorMessage =
      `Failed to parse request body\n\n` +
      `The server could not parse the request body.\n\n` +
      `Details: ${err.message}\n\n` +
      `Common causes:\n` +
      `1. Invalid JSON syntax\n` +
      `2. Content-Type header doesn't match body format\n` +
      `3. Body size exceeds limit\n\n` +
      `To fix:\n` +
      `- Verify JSON syntax is valid\n` +
      `- Ensure Content-Type header matches the data format\n` +
      `- Check if body size is within acceptable limits`;
  } else if (err.type === 'charset.unsupported') {
    errorMessage =
      `Unsupported character encoding\n\n` +
      `The Content-Type header specifies an unsupported charset.\n\n` +
      `Supported charsets: utf-8\n\n` +
      `To fix: Use UTF-8 encoding for request bodies`;
  } else if (statusCode === 500 && !err.expose) {
    // For genuine server errors, provide a generic message to avoid leaking internals
    errorMessage =
      `Internal Server Error\n\n` +
      `An unexpected error occurred while processing your request.\n\n` +
      `The error has been logged and will be investigated.\n\n` +
      `Request ID: ${req.get('X-Request-ID') || 'N/A'}\n` +
      `Timestamp: ${new Date().toISOString()}`;
  }

  // Send error response
  res.status(statusCode)
    .type('text/plain')
    .send(errorMessage);
});

server.listen(app.get('port'), () => {
  console.log(`  Replicator is running at http://localhost:${app.get('port')} in ${app.get('env')} mode`);
  console.log('  Press CTRL-C to stop\n');
});
