/**
 * Express-session configuration using connect-pg-simple as the backing store.
 *
 * Design decisions:
 *  - connect-pg-simple stores sessions in a `sessions` table in the same
 *    PostgreSQL database, so sessions survive server restarts.
 *  - The `sessions` table is created automatically on first use via
 *    `createTableIfMissing: true` — no extra migration required.
 *  - cookie.secure is set to true only in production so local HTTP
 *    development still works.
 *  - cookie.sameSite is set to "lax" for same-site deployments. Change to
 *    "none" (and ensure secure:true) if the frontend is on a different origin.
 *  - cookie.httpOnly:true prevents JavaScript from reading the session cookie.
 *  - resave:false / saveUninitialized:false comply with GDPR best practice
 *    and avoid unnecessary DB writes.
 */

import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import env from "./env.js";

const PgSession = connectPgSimple(session);

// Dedicated pool for the session store so session activity cannot interfere
// with or exhaust the main application connection pool.
const sessionPool = new pg.Pool({
  connectionString: env.databaseUrl,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

sessionPool.on("error", (error) => {
  console.error("Unexpected session pool error:", error);
});

const sessionStore = new PgSession({
  pool: sessionPool,
  createTableIfMissing: true,
  // Prune expired sessions once every 15 minutes.
  pruneSessionInterval: 60 * 15,
});

/** Milliseconds — 24 hours */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sessionMiddleware = session({
  store: sessionStore,
  secret: env.sessionSecret,
  name: "helpdesk.sid",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  },
});

export { sessionPool, sessionStore };
export default sessionMiddleware;
