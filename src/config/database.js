const { Pool } = require("pg");
const env = require("./env");

const pool = new Pool({
  connectionString: env.databaseUrl,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

module.exports = {
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
