import "dotenv/config";

const port = Number.parseInt(process.env.PORT || "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set");
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || "development",
  port,
  databaseUrl,
});

export default env;
