import "dotenv/config";

const port = Number.parseInt(process.env.PORT || "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set");
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

// Groq (AI features). Optional at boot: the AI endpoint degrades gracefully
// with a 503 when the key is absent instead of blocking the whole app.
const groqApiKey = process.env.GROQ_API_KEY || null;
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const groqTimeoutMs = process.env.GROQ_TIMEOUT_MS
  ? Number.parseInt(process.env.GROQ_TIMEOUT_MS, 10)
  : 15000;
if (!Number.isInteger(groqTimeoutMs) || groqTimeoutMs < 1000) {
  throw new Error("GROQ_TIMEOUT_MS must be an integer of at least 1000 (ms)");
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET must be set");
}
if (isProduction && sessionSecret.length < 32) {
  throw new Error(
    "SESSION_SECRET must be at least 32 characters in production",
  );
}

const env = Object.freeze({
  nodeEnv,
  isProduction,
  port,
  databaseUrl,
  sessionSecret,
  groqApiKey,
  groqModel,
  groqTimeoutMs,
});

export default env;
