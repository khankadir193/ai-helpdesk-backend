import dns from "node:dns";
import pg from "pg";
import env from "./env.js";

// Prefer IPv4 to avoid socket timeouts when dual-stack IPv6 routes are unresponsive
dns.setDefaultResultOrder?.("ipv4first");

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.databaseUrl,
  connectionTimeoutMillis: 30000,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

const database = {
  query(text, values) {
    return pool.query(text, values);
  },
  connect() {
    return pool.connect();
  },
  close() {
    return pool.end();
  },
};

export default database;
