import pg from "pg";
import env from "./env.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: env.databaseUrl,
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
