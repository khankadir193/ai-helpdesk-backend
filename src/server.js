const app = require("./app");
const env = require("./config/env");
const database = require("./config/database");

const server = app.listen(env.port, () => {
  console.log(`API listening on port ${env.port} (${env.nodeEnv})`);
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);

  server.close(async (error) => {
    try {
      await database.close();
      if (error) {
        console.error("HTTP server shutdown failed:", error);
        process.exitCode = 1;
      }
    } catch (databaseError) {
      console.error("Database pool shutdown failed:", databaseError);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
