import Groq from "groq-sdk";
import env from "../../config/env.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Map transport/provider failures from the Groq SDK to safe ApiErrors.
 * Real error details are logged server-side only; clients receive generic
 * messages that never leak the API key, base URL, or SDK internals.
 *
 * @param {unknown} error
 * @param {string} operationContext — server-side log label for the failing call
 * @returns {ApiError}
 */
function mapProviderError(error, operationContext) {
  if (error instanceof ApiError) {
    return error;
  }
  // Server-side log only — console output never reaches the HTTP layer.
  console.error(
    `[AI provider] ${operationContext} failed:`,
    error?.message ?? error,
  );

  if (error instanceof Groq.APIConnectionTimeoutError) {
    return new ApiError(
      504,
      "AI provider request timed out. Please try again later.",
    );
  }

  const status = typeof error?.status === "number" ? error.status : undefined;

  if (status === 429) {
    return new ApiError(
      429,
      "AI provider is rate limited. Please try again in a moment.",
    );
  }
  if (status !== undefined && status >= 500) {
    return new ApiError(
      502,
      "AI provider is temporarily unavailable. Please try again later.",
    );
  }
  return new ApiError(
    502,
    "AI provider request failed. No suggestion was stored.",
  );
}

/** @type {InstanceType<typeof Groq>|undefined} */
let client;

/**
 * Groq-backed chat completion provider.
 *
 * The client is created lazily on first use so that a missing GROQ_API_KEY
 * only affects AI endpoints (degraded feature, per docs/07) and never blocks
 * application startup. Exclude `maxRetries` retries: provider failures are
 * surfaced immediately to the caller (docs/07 — do not retry immediately).
 *
 * Exported as a mutable object so integration tests can substitute
 * `generateCompletion` / `mapProviderError` directly (same technique the
 * existing suites use for `database.query`).
 */
const aiProvider = {
  /**
   * Whether AI features can currently be used.
   * @returns {boolean}
   */
  isConfigured() {
    return env.groqApiKey !== null;
  },

  /**
   * Run a JSON-mode chat completion and return the raw message content.
   *
   * @param {{ system: string, user: string, operation?: string }} prompts
   *   `operation` is a server-side log label for the request.
   * @returns {Promise<{ content: string, model: string }>}
   */
  async generateCompletion({ system, user, operation = "AI request" }) {
    if (!this.isConfigured()) {
      throw new ApiError(
        503,
        "AI features are not configured on the server yet.",
      );
    }
    // Recreate the client if the test harness swapped configuration.
    if (!client || client.apiKey !== env.groqApiKey) {
      client = new Groq({
        apiKey: env.groqApiKey,
        timeout: env.groqTimeoutMs,
        maxRetries: 0,
      });
    }
    try {
      const response = await client.chat.completions.create({
        model: env.groqModel,
        temperature: 0.1,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return {
        content: response.choices?.[0]?.message?.content ?? "",
        model: env.groqModel,
      };
    } catch (error) {
      throw mapProviderError(error, operation);
    }
  },

  mapProviderError,
  // Exposed for direct unit coverage of the error mapping rules.
  _groqModule: Groq,
};

export default aiProvider;
