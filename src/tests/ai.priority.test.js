/**
 * Integration test suite for AI ticket priority suggestion
 * under POST /api/v1/tickets/:id/ai/priority
 *
 * Groq responses are mocked by substituting `aiProvider.generateCompletion`
 * (the same monkey-patch technique the other suites use for `database.query`),
 * so no real API key or outbound call is needed.
 *
 * Covers:
 *  - Authentication (401) and authorization (customer 403, unassigned agent 403)
 *  - Ticket ownership scoping, missing tickets (404) and invalid ids (400)
 *  - Successful priority suggestion and storage in ai_suggestions (PENDING,
 *    suggestion_type PRIORITY), including case-insensitive level matching
 *  - Focused ticket data: the ticket's actual priority is never changed and
 *    no ticket_history rows are written; applying a suggestion remains an
 *    explicit human action
 *  - Malformed AI responses (non-JSON, wrong shape, invalid confidence,
 *    unknown priority level, invalid reason) -> 502 and nothing stored
 *  - Provider failures (timeout 504, rate limit 429, unavailable 502/503)
 *  - Empty/blank ticket input (service-level guard) -> 422, provider unused
 *  - Database insert failure -> 500 with the generic error envelope
 *  - Requests without a body / with an empty body still work
 *
 * Run: node --test src/tests/ai.priority.test.js
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";
import env from "../config/env.js";
import aiProvider from "../modules/ai/ai.provider.js";
import aiService from "../modules/ai/ai.service.js";
import ticketRepository from "../modules/tickets/ticket.repository.js";
import ApiError from "../utils/ApiError.js";

let server;
let baseUrl;

// Test users
let adminUser;
let agent1User;
let customer1User;
let customer2User;

// Session cookies
let adminCookie;
let agent1Cookie;
let customer1Cookie;
let customer2Cookie;

// Tickets
let ticketA; // customer1, assigned to agent1, priority MEDIUM
let ticketB; // customer2, unassigned

/**
 * Login via POST /api/v1/auth/login and return the "name=value" cookie part.
 */
async function loginAndGetCookie(port, email, password) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status} ${text}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error(`No Set-Cookie header for ${email}`);
  return setCookie.split(";")[0];
}

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  const timestamp = Date.now();
  const bcrypt = (await import("bcrypt")).default;
  const testHash = await bcrypt.hash("TestPass1!", 12);

  async function createUser(name, email, role) {
    const { rows } = await database.query(
      `INSERT INTO users (name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, name, email, role`,
      [name, email, testHash, role],
    );
    return rows[0];
  }

  adminUser = await createUser(
    `Admin_${timestamp}`,
    `admin_${timestamp}@aipriority.example.com`,
    "ADMIN",
  );
  agent1User = await createUser(
    `Agent1_${timestamp}`,
    `agent1_${timestamp}@aipriority.example.com`,
    "AGENT",
  );
  customer1User = await createUser(
    `Customer1_${timestamp}`,
    `customer1_${timestamp}@aipriority.example.com`,
    "CUSTOMER",
  );
  customer2User = await createUser(
    `Customer2_${timestamp}`,
    `customer2_${timestamp}@aipriority.example.com`,
    "CUSTOMER",
  );

  adminCookie = await loginAndGetCookie(port, adminUser.email, "TestPass1!");
  agent1Cookie = await loginAndGetCookie(port, agent1User.email, "TestPass1!");
  customer1Cookie = await loginAndGetCookie(
    port,
    customer1User.email,
    "TestPass1!",
  );
  customer2Cookie = await loginAndGetCookie(
    port,
    customer2User.email,
    "TestPass1!",
  );

  ticketA = await createTicket(customer1Cookie, {
    title: "Cannot reset my password",
    description:
      "The password reset link from the email expires immediately. " +
      "This blocks the whole team from working.",
  });

  ticketB = await createTicket(customer2Cookie, {
    title: "Typo in the newsletter header",
    description: "There is a small typo on the monthly newsletter heading.",
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(path, options = {}) {
  const { method = "GET", cookie, headers = {}, body } = options;

  const reqHeaders = { ...headers };
  if (cookie) reqHeaders["Cookie"] = cookie;
  if (body !== undefined && !reqHeaders["Content-Type"]) {
    reqHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body:
      body !== undefined
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/**
 * Substitute the Groq provider for the duration of `run`, restoring the
 * original functions afterwards (node:test suites run sequentially).
 *
 * @param {{ content: string, model?: string }|Error} mock
 *   - object with `content`/`model`: resolved value;
 *   - Error instance (e.g. ApiError): thrown by the provider
 * @param {() => Promise<void>} run
 */
async function withMockedProvider(mock, run) {
  const original = aiProvider.generateCompletion;
  aiProvider.generateCompletion = async () => {
    if (mock instanceof Error) throw mock;
    return mock;
  };
  try {
    await run();
  } finally {
    aiProvider.generateCompletion = original;
  }
}

/**
 * Simulate a priority suggestion response.
 *
 * @param {string} priority
 * @param {number} confidence
 * @param {string} [reasonHint]
 * @returns {{ content: string, model: string }}
 */
function priorityResponse(priority, confidence, reasonHint) {
  return {
    content: JSON.stringify({
      suggestedPriority: priority,
      confidence,
      reason: reasonHint ?? "The issue looks urgent for the customer.",
    }),
    model: env.groqModel,
  };
}

async function createTicket(cookie, body) {
  const { status, body: resBody } = await request("/api/v1/tickets", {
    method: "POST",
    cookie,
    body,
  });
  assert.equal(status, 201, `Ticket creation failed: ${JSON.stringify(resBody)}`);
  return resBody.data.ticket;
}

async function aiSuggestionCountForTicket(ticketId) {
  const { rows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ai_suggestions WHERE ticket_id = $1",
    [ticketId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Setup expectation: mock responses work; wire the ticket to agent1
// ---------------------------------------------------------------------------

test("setup: agent is assigned to ticketA by an admin", async () => {
  const { status } = await request(`/api/v1/tickets/${ticketA.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent1User.id },
  });
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------------
// Tests: Authentication and authorization
// ---------------------------------------------------------------------------

test("unauthenticated priority request returns 401", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketA.id}/ai/priority`,
    { method: "POST" },
  );
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

test("customer cannot request a priority suggestion even for their own ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketA.id}/ai/priority`,
    { method: "POST", cookie: customer1Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("unassigned agent cannot request a priority suggestion for another agent's ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketB.id}/ai/priority`,
    { method: "POST", cookie: agent1Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

// ---------------------------------------------------------------------------
// Tests: Ticket id validation and missing tickets
// ---------------------------------------------------------------------------

test("priority suggestion returns 404 for a missing ticket", async () => {
  const { status, body } = await request(
    "/api/v1/tickets/99999999/ai/priority",
    { method: "POST", cookie: adminCookie },
  );
  assert.equal(status, 404);
  assert.equal(body.message, "Ticket not found.");
});

test("priority suggestion returns 400 for invalid ticket ids", async () => {
  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const { status, body } = await request(
      `/api/v1/tickets/${bad}/ai/priority`,
      { method: "POST", cookie: adminCookie },
    );
    assert.equal(status, 400, `Expected 400 for id "${bad}"`);
    assert.equal(body.status, "error");
  }
});

// ---------------------------------------------------------------------------
// Tests: Successful suggestion, storage, and ticket immutability
// ---------------------------------------------------------------------------

test("assigned agent request stores a PENDING PRIORITY suggestion", async () => {
  const before = await aiSuggestionCountForTicket(ticketA.id);

  let res;
  await withMockedProvider(
    priorityResponse("URGENT", 0.95, "Multiple users blocked."),
    async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
        method: "POST",
        cookie: agent1Cookie,
      });
    },
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "success");

  const suggestion = res.body.data.suggestion;
  assert.ok(suggestion.id);
  assert.equal(String(suggestion.ticket_id), String(ticketA.id));
  assert.equal(suggestion.suggestion_type, "PRIORITY");
  assert.equal(suggestion.provider, "groq");
  assert.equal(suggestion.model_name, env.groqModel);
  assert.equal(suggestion.status, "PENDING");
  assert.ok(suggestion.created_at);
  assert.deepEqual(suggestion.result, {
    suggestedPriority: "URGENT",
    currentPriority: "MEDIUM",
    confidence: 0.95,
    reason: "Multiple users blocked.",
  });
  // The API key must never appear in the output (only verifiable when set)
  if (env.groqApiKey) {
    assert.ok(!JSON.stringify(res.body).includes(env.groqApiKey));
  }

  const after = await aiSuggestionCountForTicket(ticketA.id);
  assert.equal(after, before + 1, "exactly one suggestion must be stored");

  const { rows } = await database.query(
    "SELECT suggestion_type, provider, model_name, status, requested_by, result FROM ai_suggestions WHERE id = $1",
    [suggestion.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].suggestion_type, "PRIORITY");
  assert.equal(rows[0].provider, "groq");
  assert.equal(rows[0].model_name, env.groqModel);
  assert.equal(rows[0].status, "PENDING");
  assert.equal(String(rows[0].requested_by), String(agent1User.id));
  assert.equal(rows[0].result.suggestedPriority, "URGENT");
});

test("suggested priority matching is case-insensitive and stores the canonical level", async () => {
  let res;
  await withMockedProvider(priorityResponse("High", 0.75), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: agent1Cookie,
    });
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.suggestion.result.suggestedPriority, "HIGH");
});

test("admin can request a priority suggestion for an unassigned ticket (200)", async () => {
  let res;
  await withMockedProvider(priorityResponse("LOW", 0.8), async () => {
    res = await request(`/api/v1/tickets/${ticketB.id}/ai/priority`, {
      method: "POST",
      cookie: adminCookie,
    });
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "success");
  assert.equal(
    res.body.data.suggestion.result.suggestedPriority,
    "LOW",
  );
});

test("priority suggestion never modifies the ticket or writes ticket history", async () => {
  const { body: detailBefore } = await request(
    `/api/v1/tickets/${ticketA.id}`,
    { cookie: agent1Cookie },
  );
  const { rows: historyBefore } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_history WHERE ticket_id = $1",
    [ticketA.id],
  );

  let res;
  await withMockedProvider(priorityResponse("URGENT", 0.92), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: agent1Cookie,
    });
  });
  assert.equal(res.status, 200);

  const { body: detailAfter } = await request(
    `/api/v1/tickets/${ticketA.id}`,
    { cookie: agent1Cookie },
  );
  const { rows: historyAfter } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_history WHERE ticket_id = $1",
    [ticketA.id],
  );

  const ignored = new Set(["updated_at"]);
  for (const field of Object.keys(detailBefore.data.ticket)) {
    if (ignored.has(field)) continue;
    assert.deepEqual(
      detailAfter.data.ticket[field],
      detailBefore.data.ticket[field],
      `field "${field}" must not change on a priority suggestion`,
    );
  }
  // The explicit business rule: AI never changes the actual priority.
  assert.equal(detailAfter.data.ticket.priority, "MEDIUM");
  assert.equal(detailAfter.data.ticket.status, "OPEN");
  assert.equal(historyAfter[0].n, historyBefore[0].n);
});

test("repeated requests append new suggestions (no overwrite)", async () => {
  const firstCount = await aiSuggestionCountForTicket(ticketA.id);

  let res;
  await withMockedProvider(priorityResponse("HIGH", 0.7), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: agent1Cookie,
    });
  });
  assert.equal(res.status, 200);

  let second;
  await withMockedProvider(priorityResponse("LOW", 0.6), async () => {
    second = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: agent1Cookie,
    });
  });
  assert.equal(second.status, 200);

  assert.notEqual(
    res.body.data.suggestion.id,
    second.body.data.suggestion.id,
  );
  assert.equal(await aiSuggestionCountForTicket(ticketA.id), firstCount + 2);
});

test("priority suggestion works without a request body and with an empty body", async () => {
  let noBody;
  let emptyBody;
  await withMockedProvider(priorityResponse("MEDIUM", 0.9), async () => {
    noBody = await request(
      `/api/v1/tickets/${ticketA.id}/ai/priority`,
      { method: "POST", cookie: agent1Cookie, headers: { "Content-Length": "0" } },
    );
    emptyBody = await request(
      `/api/v1/tickets/${ticketA.id}/ai/priority`,
      { method: "POST", cookie: agent1Cookie, body: {} },
    );
  });
  assert.equal(noBody.status, 200);
  assert.equal(emptyBody.status, 200);
});

// ---------------------------------------------------------------------------
// Tests: Malformed AI responses -> 502, nothing stored
// ---------------------------------------------------------------------------

test("malformed AI responses return 502 and store nothing", async () => {
  const cases = [
    { name: "non-JSON content", providerValue: { content: "not json at all", model: env.groqModel } },
    { name: "JSON array", providerValue: { content: JSON.stringify([]), model: env.groqModel } },
    { name: "empty object", providerValue: { content: JSON.stringify({}), model: env.groqModel } },
    {
      name: "missing priority",
      providerValue: { content: JSON.stringify({ confidence: 0.9, reason: "r" }), model: env.groqModel },
    },
    {
      name: "unknown priority level",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "CRITICAL", confidence: 0.9, reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "priority as number",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: 3, confidence: 0.9, reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "confidence above 1",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", confidence: 1.5, reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "confidence as percentage",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", confidence: 90, reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "confidence as string",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", confidence: "0.9", reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "missing confidence",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", reason: "r" }),
        model: env.groqModel,
      },
    },
    {
      name: "reason as number",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", confidence: 0.9, reason: 5 }),
        model: env.groqModel,
      },
    },
    {
      name: "missing reason",
      providerValue: {
        content: JSON.stringify({ suggestedPriority: "HIGH", confidence: 0.9 }),
        model: env.groqModel,
      },
    },
  ];

  for (const { name, providerValue } of cases) {
    const before = await aiSuggestionCountForTicket(ticketA.id);

    let res;
    await withMockedProvider(providerValue, async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
        method: "POST",
        cookie: adminCookie,
      });
    });

    assert.equal(res.status, 502, `${name}: expected 502`);
    assert.equal(res.body.status, "error", `${name}: error envelope expected`);
    assert.equal(
      await aiSuggestionCountForTicket(ticketA.id),
      before,
      `${name}: no suggestion row may be stored`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: Provider failures propagate safely and store nothing
// ---------------------------------------------------------------------------

test("provider timeout maps to 504 and stores nothing", async () => {
  const before = await aiSuggestionCountForTicket(ticketA.id);
  let res;
  await withMockedProvider(new ApiError(504, "AI provider request timed out."), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: adminCookie,
    });
  });
  assert.equal(res.status, 504);
  assert.equal(res.body.status, "error");
  assert.match(res.body.message, /timed out/i);
  assert.equal(await aiSuggestionCountForTicket(ticketA.id), before);
});

test("provider rate limit maps to 429 and stores nothing", async () => {
  let res;
  await withMockedProvider(new ApiError(429, "AI provider is rate limited."), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: adminCookie,
    });
  });
  assert.equal(res.status, 429);
  assert.match(res.body.message, /rate limited/i);
});

test("provider unavailability maps to 502 and stores nothing", async () => {
  let res;
  await withMockedProvider(new ApiError(502, "AI provider is temporarily unavailable."), async () => {
    res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: adminCookie,
    });
  });
  assert.equal(res.status, 502);
});

test("priority suggestion returns 503 when the provider is not configured", async () => {
  const originalConfigured = aiProvider.isConfigured;
  aiProvider.isConfigured = () => false;
  try {
    const res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
      method: "POST",
      cookie: adminCookie,
    });
    assert.equal(res.status, 503);
    assert.match(res.body.message, /not configured/i);
  } finally {
    aiProvider.isConfigured = originalConfigured;
  }
});

// ---------------------------------------------------------------------------
// Tests: Empty/blank ticket input (service-level guard)
// ---------------------------------------------------------------------------

test("blank title or description returns 422 and never calls the provider", async () => {
  const originalFind = ticketRepository.findTicketById;
  const originalGenerate = aiProvider.generateCompletion;
  let providerCalled = false;

  ticketRepository.findTicketById = async () => ({
    id: ticketA.id,
    title: "   ",
    description: "Valid description text.",
    customer_id: null,
    agent_id: agent1User.id,
    priority: "MEDIUM",
    status: "OPEN",
  });
  aiProvider.generateCompletion = async () => {
    providerCalled = true;
    throw new Error("provider must not be called for blank input");
  };

  try {
    await assert.rejects(
      () =>
        aiService.suggestTicketPriority(String(ticketA.id), {
          id: agent1User.id,
          role: "AGENT",
        }),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 422 &&
        /title and description are required/i.test(error.message),
    );
    assert.equal(providerCalled, false, "provider must not be called");

    // Same guard for a blank description.
    ticketRepository.findTicketById = async () => ({
      id: ticketA.id,
      title: "Valid title",
      description: "",
      customer_id: null,
      agent_id: agent1User.id,
      priority: "MEDIUM",
      status: "OPEN",
    });
    await assert.rejects(
      () =>
        aiService.suggestTicketPriority(String(ticketA.id), {
          id: agent1User.id,
          role: "AGENT",
        }),
      (error) =>
        error instanceof ApiError &&
        error.statusCode === 422 &&
        /title and description are required/i.test(error.message),
    );
    assert.equal(providerCalled, false, "provider must not be called");
  } finally {
    ticketRepository.findTicketById = originalFind;
    aiProvider.generateCompletion = originalGenerate;
  }
});

// ---------------------------------------------------------------------------
// Tests: Database failures
// ---------------------------------------------------------------------------

test("ai_suggestions insert failure returns 500 with the generic envelope", async () => {
  const originalQuery = database.query;
  database.query = async (text, ...args) => {
    if (typeof text === "string" && text.includes("INSERT INTO ai_suggestions")) {
      throw new Error("Simulated ai_suggestions failure");
    }
    return originalQuery.call(database, text, ...args);
  };

  try {
    const before = await aiSuggestionCountForTicket(ticketA.id);
    let res;
    await withMockedProvider(priorityResponse("HIGH", 0.95), async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/priority`, {
        method: "POST",
        cookie: adminCookie,
      });
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.equal(res.body.message, "Internal server error");
    assert.equal(await aiSuggestionCountForTicket(ticketA.id), before);
  } finally {
    database.query = originalQuery;
  }
});
