import dns from "node:dns";
import pg from "pg";
import env from "./env.js";

// Prefer IPv4 to avoid socket timeouts when dual-stack IPv6 routes are unresponsive
dns.setDefaultResultOrder?.("ipv4first");

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.databaseUrl,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 10000,
  keepAlive: true,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

const database = {
  async query(text, values) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      if (
        error.code === "ECONNRESET" ||
        error.message?.includes("ECONNRESET") ||
        error.message?.includes("Connection terminated unexpectedly")
      ) {
        return pool.query(text, values);
      }
      throw error;
    }
  },
  connect() {
    return pool.connect();
  },
  close() {
    return pool.end();
  },
};

export default database;
