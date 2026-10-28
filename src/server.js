import app from "./app.js";
import env from "./config/env.js";
import database from "./config/database.js";
import { sessionPool, sessionStore } from "./config/session.js";

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
      if (typeof sessionStore.stopExpiringSessions === "function") {
        sessionStore.stopExpiringSessions();
      }
      await Promise.allSettled([
        database.close(),
        sessionPool.end(),
      ]);
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
