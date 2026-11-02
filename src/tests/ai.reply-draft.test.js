/**
 * Integration test suite for AI reply drafts for support agents
 * under POST /api/v1/tickets/:id/ai/reply-draft
 *
 * Groq responses are mocked by substituting `aiProvider.generateCompletion`
 * (the same monkey-patch technique the other suites use for `database.query`),
 * so no real API key or outbound call is needed.
 *
 * Covers:
 *  - Authentication (401) and authorization (customer 403, unassigned agent 403)
 *  - Ticket ownership scoping, missing tickets (404) and invalid ids (400)
 *  - Successful draft generation and storage in ai_suggestions (PENDING,
 *    suggestion_type REPLY_DRAFT)
 *  - Tickets with NO previous comments (first reply drafted from the ticket
 *    details alone)
 *  - Tickets with multiple comments (customer-visible conversation is sent;
 *    internal notes, customer names and emails are never included)
 *  - Draft-only behaviour: no ticket_comments row is ever created
 *    automatically and the ticket itself is never modified (no
 *    ticket_history rows, status/priority/category untouched)
 *  - Malformed AI responses (non-JSON, wrong shape, empty/whitespace draft,
 *    non-string draft) -> 502 and nothing stored
 *  - Provider failures (timeout 504, rate limit 429, unavailable 502)
 *  - Not-configured provider -> 503
 *  - Empty input (blank ticket text -> 422) and excessive conversation
 *    (oldest turns truncated, newest kept, prompt bounded)
 *  - Database insert failure -> 500 with the generic error envelope
 *  - Requests without a body / with an empty body still work
 *
 * Run: node --test src/tests/ai.reply-draft.test.js
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

// Ticket with a conversation of comments (customer1, assigned to agent1)
// Tickets
let ticketA; // customer1, assigned to agent1, no comments
let ticketB; // customer2, unassigned
let ticketC; // customer1, assigned to agent1, with a conversation
let ticketD; // customer1, assigned to agent1, oversized conversation

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
    `admin_${timestamp}@replydraft.example.com`,
    "ADMIN",
  );
  agent1User = await createUser(
    `Agent1_${timestamp}`,
    `agent1_${timestamp}@replydraft.example.com`,
    "AGENT",
  );
  customer1User = await createUser(
    `Customer1_${timestamp}`,
    `customer1_${timestamp}@replydraft.example.com`,
    "CUSTOMER",
  );
  customer2User = await createUser(
    `Customer2_${timestamp}`,
    `customer2_${timestamp}@replydraft.example.com`,
    "CUSTOMER",
  );

  adminCookie = await loginAndGetCookie(port, adminUser.email, "TestPass1!");
  agent1Cookie = await loginAndGetCookie(port, agent1User.email, "TestPass1!");
  customer1Cookie = await loginAndGetCookie(
    port,
    customer1User.email,
    "TestPass1!",
  );

  const category = (
    await request("/api/v1/categories", {
      method: "POST",
      cookie: adminCookie,
      body: { name: `General_${timestamp}` },
    })
  ).body.data.category;
  catGeneral = category;

  ticketA = await createTicket(customer1User, {
    title: "Cannot reset my password",
    description: "The password reset link from the email expires immediately.",
    category_id: catGeneral.id,
  });

  ticketB = await createTicket(customer2User, {
    title: "Monthly invoice is wrong",
    description: "The invoice shows twice the actual subscription price.",
    category_id: catGeneral.id,
  });

  ticketC = await createTicket(customer1User, {
    title: "CSV export produces garbled columns",
    description: "Exported reports open with mixed-up columns in Excel.",
    category_id: catGeneral.id,
  });

  ticketD = await createTicket(customer1User, {
    title: "Performance degrades at scale",
    description: "Load times grow linearly with the number of saved views.",
    category_id: catGeneral.id,
  });

  // ticketA, ticketC and ticketD are assigned to agent1.
  for (const ticket of [ticketA, ticketC, ticketD]) {
    const { status } = await request(`/api/v1/tickets/${ticket.id}/assignment`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: agent1User.id },
    });
    assert.equal(status, 200, "Assignment of a fixture ticket failed");
  }

  // Conversation on ticketC: customer question, agent answer, an internal
  // note that must never reach the AI provider, and a follow-up.
  await addComment(
    customer1Cookie,
    ticketC.id,
    "The CSV export broke my column order. I need the report for accounting.",
  );
  await addComment(
    agent1Cookie,
    ticketC.id,
    INTERNAL_NOTE_SENTINEL, // must be excluded
    true,
  );
  await addComment(
    customer1Cookie,
    ticketC.id,
    "It only happens with the large monthly reports.",
  );
  await addComment(
    agent1Cookie,
    ticketC.id,
    "Thanks, our engineers are investigating the large-report path.",
  );
  await addComment(
    customer1Cookie,
    ticketC.id,
    "Can you confirm which format the accounting team should use meanwhile?",
  );

  // Oversized conversation on ticketD: 30 alternating long messages.
  for (let i = 0; i < 30; i++) {
    const author = i % 2 === 0 ? customer1Cookie : agent1Cookie;
    await addComment(
      author,
      ticketD.id,
      `Msg_${i}_${"x".repeat(1000)}`,
    );
  }
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

const INTERNAL_NOTE_SENTINEL = "REPLY_INTERNAL_NOTE_SENTINEL_xyzzy";

// Ticket metadata values used by the fixtures below.
let catGeneral;

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

async function addComment(cookie, ticketId, message, isInternal = false) {
  const { status } = await request(`/api/v1/tickets/${ticketId}/comments`, {
    method: "POST",
    cookie,
    body: { message, ...(isInternal ? { is_internal: true } : {}) },
  });
  assert.equal(status, 201, `Fixture comment creation failed on ${ticketId}`);
}

/**
 * Substitute the Groq provider for the duration of `run`, recording every
 * prompt handed to the provider, restoring the original function afterwards
 * (node:test suites run sequentially).
 *
 * @param {{ content: string, model?: string }|Error} mock
 *   - object with `content`/`model`: resolved value;
 *   - Error instance (e.g. ApiError): thrown by the provider
 * @param {() => Promise<void>} run
 * @returns {Promise<Array<{ system: string, user: string }>>} captured prompts
 */
async function withMockedProvider(mock, run) {
  const original = aiProvider.generateCompletion;
  const captured = [];
  aiProvider.generateCompletion = async (prompts) => {
    captured.push(prompts);
    if (mock instanceof Error) throw mock;
    return mock;
  };
  try {
    await run();
  } finally {
    aiProvider.generateCompletion = original;
  }
  return captured;
}

/**
 * Simulate a valid reply-draft response.
 *
 * @param {string} draft
 * @returns {{ content: string, model: string }}
 */
function replyDraftResponse(draft) {
  return {
    content: JSON.stringify({ draft }),
    model: env.groqModel,
  };
}

async function createTicket(customer, body) {
  const { rows } = await database.query(
    `INSERT INTO tickets (title, description, customer_id, category_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [body.title, body.description, customer.id, body.category_id ?? null],
  );
  return rows[0];
}

async function replyDraftCountForTicket(ticketId) {
  const { rows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ai_suggestions WHERE ticket_id = $1 AND suggestion_type = 'REPLY_DRAFT'",
    [ticketId],
  );
  return rows[0].n;
}

async function commentCountForTicket(ticketId) {
  const { rows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_comments WHERE ticket_id = $1",
    [ticketId],
  );
  return rows[0].n;
}

async function ticketHistoryCountForTicket(ticketId) {
  const { rows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_history WHERE ticket_id = $1",
    [ticketId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Tests: Authentication and authorization
// ---------------------------------------------------------------------------

test("unauthenticated reply-draft request returns 401", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketA.id}/ai/reply-draft`,
    { method: "POST" },
  );
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

test("customer cannot request a reply draft even for their own ticket (403)", async () => {
  const before = await replyDraftCountForTicket(ticketA.id);
  const { status, body } = await request(
    `/api/v1/tickets/${ticketA.id}/ai/reply-draft`,
    { method: "POST", cookie: customer1Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
  assert.equal(await replyDraftCountForTicket(ticketA.id), before);
});

test("customer cannot request a reply draft for somebody else's ticket (403)", async () => {
  const { status } = await request(
    `/api/v1/tickets/${ticketB.id}/ai/reply-draft`,
    { method: "POST", cookie: customer1Cookie },
  );
  assert.equal(status, 403);
});

test("unassigned agent cannot generate a draft for an unassigned ticket (403)", async () => {
  const before = await replyDraftCountForTicket(ticketB.id);
  const { status, body } = await request(
    `/api/v1/tickets/${ticketB.id}/ai/reply-draft`,
    { method: "POST", cookie: agent1Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
  assert.equal(await replyDraftCountForTicket(ticketB.id), before);
});

// ---------------------------------------------------------------------------
// Tests: Ticket id validation and missing tickets
// ---------------------------------------------------------------------------

test("reply-draft generation returns 404 for a missing ticket", async () => {
  const { status, body } = await request(
    "/api/v1/tickets/99999999/ai/reply-draft",
    { method: "POST", cookie: adminCookie },
  );
  assert.equal(status, 404);
  assert.equal(body.message, "Ticket not found.");
});

test("reply-draft generation returns 400 for invalid ticket ids", async () => {
  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const { status, body } = await request(
      `/api/v1/tickets/${bad}/ai/reply-draft`,
      { method: "POST", cookie: adminCookie },
    );
    assert.equal(status, 400, `Expected 400 for id "${bad}"`);
    assert.equal(body.status, "error");
  }
});

// ---------------------------------------------------------------------------
// Tests: Tickets with no previous comments
// ---------------------------------------------------------------------------

test("assigned agent gets a first-reply draft for a ticket without comments", async () => {
  const beforeSuggestions = await replyDraftCountForTicket(ticketA.id);
  const beforeComments = await commentCountForTicket(ticketA.id);

  let res;
  const prompts = await withMockedProvider(
    replyDraftResponse("Hi, sorry about the reset link trouble. Could you confirm the email address you registered with so we can look into it?"),
    async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
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
  assert.equal(suggestion.suggestion_type, "REPLY_DRAFT");
  assert.equal(suggestion.provider, "groq");
  assert.equal(suggestion.model_name, env.groqModel);
  assert.equal(suggestion.status, "PENDING");
  assert.ok(suggestion.created_at);
  assert.equal(
    typeof suggestion.result.draft,
    "string",
    "the API must return the draft text",
  );
  assert.ok(suggestion.result.draft.trim().length > 0);

  // No customer-visible conversation existed in the prompt.
  assert.equal(prompts.length, 1);
  assert.ok(
    prompts[0].user.includes("(no customer-visible comments yet"),
    "the empty-conversation branch must be used",
  );
  assert.ok(prompts[0].user.includes("Cannot reset my password"));
  assert.ok(prompts[0].user.includes("Ticket priority:"));
  // Data minimisation: names/emails of the customer are never sent.
  assert.ok(!prompts[0].user.includes(customer1User.email));
  assert.ok(!prompts[0].user.includes(customer1User.name));
  // The API key must never appear in the output (only verifiable when set)
  if (env.groqApiKey) {
    assert.ok(!JSON.stringify(res.body).includes(env.groqApiKey));
  }

  assert.equal(await replyDraftCountForTicket(ticketA.id), beforeSuggestions + 1);
  // Draft only: no comment may be created automatically.
  assert.equal(await commentCountForTicket(ticketA.id), beforeComments);
});

test("admin can generate a draft for an unassigned ticket (200)", async () => {
  const before = await commentCountForTicket(ticketB.id);
  let res;
  await withMockedProvider(
    replyDraftResponse("Hi, thanks for the report. Could you tell us whether this affects every invoice or only the latest one?"),
    async () => {
      res = await request(`/api/v1/tickets/${ticketB.id}/ai/reply-draft`, {
        method: "POST",
        cookie: adminCookie,
      });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.suggestion.suggestion_type, "REPLY_DRAFT");
  assert.equal(res.body.data.suggestion.status, "PENDING");
  assert.equal(await commentCountForTicket(ticketB.id), before);
});

test("reply-draft generation works without a request body and with an empty body", async () => {
  await withMockedProvider(
    replyDraftResponse("Hi, we are on it. Which browser version are you using?"),
    async () => {
      const noBody = await request(
        `/api/v1/tickets/${ticketA.id}/ai/reply-draft`,
        { method: "POST", cookie: agent1Cookie, headers: { "Content-Length": "0" } },
      );
      assert.equal(noBody.status, 200);

      const emptyBody = await request(
        `/api/v1/tickets/${ticketA.id}/ai/reply-draft`,
        { method: "POST", cookie: agent1Cookie, body: {} },
      );
      assert.equal(emptyBody.status, 200);
    },
  );
});

// ---------------------------------------------------------------------------
// Tests: Tickets with multiple comments
// ---------------------------------------------------------------------------

test("conversation comments are included as context, internal notes never reach the provider", async () => {
  const beforeComments = await commentCountForTicket(ticketC.id);
  const beforeSuggestions = await replyDraftCountForTicket(ticketC.id);

  let res;
  const prompts = await withMockedProvider(
    replyDraftResponse("Hi, the column ordering issue in large monthly reports is still under investigation. Meanwhile, please ask the accounting team to use the standard format, which exports correctly."),
    async () => {
      res = await request(`/api/v1/tickets/${ticketC.id}/ai/reply-draft`, {
        method: "POST",
        cookie: agent1Cookie,
      });
    },
  );

  assert.equal(res.status, 200);
  assert.ok(res.body.data.suggestion.result.draft.length > 0);
  assert.equal(await replyDraftCountForTicket(ticketC.id), beforeSuggestions + 1);

  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.ok(
    prompt.user.includes("Customer: The CSV export broke my column order"),
    "customer messages must be labelled in the conversation",
  );
  assert.ok(
    prompt.user.includes("Support agent: Thanks, our engineers are investigating"),
    "agent messages must be labelled in the conversation",
  );
  assert.ok(
    prompt.user.includes(
      "Customer: Can you confirm which format the accounting team should use",
    ),
    "the newest message must be present",
  );
  assert.ok(
    prompt.user.includes("Ticket category:") && prompt.user.includes("Ticket priority:"),
    "category/priority context must be part of the prompt",
  );
  assert.ok(
    !JSON.stringify(prompt).includes(INTERNAL_NOTE_SENTINEL),
    "internal notes must never reach the AI provider",
  );
  assert.ok(!prompt.user.includes(customer1User.email));
  assert.ok(!prompt.user.includes(agent1User.email));

  // Draft only: the conversation is not extended by draft generation.
  assert.equal(await commentCountForTicket(ticketC.id), beforeComments);
});

test("generating a draft never modifies the ticket or writes ticket history", async () => {
  const { body: detailBefore } = await request(
    `/api/v1/tickets/${ticketA.id}`,
    { cookie: agent1Cookie },
  );
  const historyBefore = await ticketHistoryCountForTicket(ticketA.id);

  await withMockedProvider(
    replyDraftResponse("Hi, could you confirm the exact error message you see?"),
    async () => {
      const res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
        method: "POST",
        cookie: agent1Cookie,
      });
      assert.equal(res.status, 200);
    },
  );

  const { body: detailAfter } = await request(
    `/api/v1/tickets/${ticketA.id}`,
    { cookie: agent1Cookie },
  );
  const historyAfter = await ticketHistoryCountForTicket(ticketA.id);

  const ignored = new Set(["updated_at"]);
  for (const field of Object.keys(detailBefore.data.ticket)) {
    if (ignored.has(field)) continue;
    assert.deepEqual(
      detailAfter.data.ticket[field],
      detailBefore.data.ticket[field],
      `field "${field}" must not change on reply-draft generation`,
    );
  }
  assert.equal(detailAfter.data.ticket.status, "OPEN");
  assert.equal(historyAfter, historyBefore);
});

// ---------------------------------------------------------------------------
// Tests: Empty or excessive conversation input
// ---------------------------------------------------------------------------

test("excessive conversation input is bounded: newest turns kept, oldest dropped", async () => {
  const beforeComments = await commentCountForTicket(ticketD.id);

  let res;
  const prompts = await withMockedProvider(
    replyDraftResponse("Hi, thanks for the detailed timeline. We are looking into the saved-views performance."),
    async () => {
      res = await request(`/api/v1/tickets/${ticketD.id}/ai/reply-draft`, {
        method: "POST",
        cookie: agent1Cookie,
      });
    },
  );

  assert.equal(res.status, 200);
  assert.equal(await commentCountForTicket(ticketD.id), beforeComments);

  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.ok(prompt.user.includes("Customer conversation (oldest first):"));

  // The newest message must survive trimming; the oldest must be dropped.
  assert.ok(
    prompt.user.includes("Msg_29_"),
    "the newest comment must be kept",
  );
  assert.ok(
    !prompt.user.includes("Msg_0_"),
    "the oldest comments must be truncated away",
  );
  assert.ok(
    !JSON.stringify(prompt).includes("Msg_9_"),
    "only the most recent turns should be kept",
  );

  // Bounded size: MAX_CONVERSATION_LENGTH (6000) plus the ticket preamble.
  assert.ok(
    prompt.user.length <= 7000,
    `prompt must stay bounded, got ${prompt.user.length}`,
  );
});

test("direct buildReplyDraftMessages keeps the prompt within bounds", () => {
  const comments = [];
  for (let i = 0; i < 25; i++) {
    comments.push({ message: `c${i}_${"y".repeat(2000)}`, author_role: "CUSTOMER" });
  }
  const { user } = aiService.buildReplyDraftMessages(
    {
      title: "t",
      description: "d",
      categoryName: null,
      priority: "MEDIUM",
    },
    comments,
  );
  assert.ok(user.length <= 7000, `user prompt must stay bounded, got ${user.length}`);
  assert.ok(user.includes("c24_"), "newest comment kept");
  assert.ok(!user.includes("c0_"), "oldest comment dropped");
});

// ---------------------------------------------------------------------------
// Tests: Blank ticket text guard
// ---------------------------------------------------------------------------

test("blank title or description returns 422 and never calls the provider", async () => {
  // PostgreSQL correctly forbids blank ticket text, so this defensive guard
  // is exercised against the service with a stubbed repository row (the
  // same technique used by the priority suite for this guard).
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
        aiService.generateReplyDraft(String(ticketA.id), {
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
      description: "   ",
      customer_id: null,
      agent_id: agent1User.id,
      priority: "MEDIUM",
      status: "OPEN",
    });
    await assert.rejects(
      () =>
        aiService.generateReplyDraft(String(ticketA.id), {
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
// Tests: Malformed AI responses -> 502, nothing stored
// ---------------------------------------------------------------------------

test("malformed AI responses return 502 and store nothing", async () => {
  const cases = [
    { name: "non-JSON content", providerValue: { content: "Here is my draft: hi!", model: env.groqModel } },
    { name: "JSON array", providerValue: { content: JSON.stringify(["draft"]), model: env.groqModel } },
    { name: "empty object", providerValue: { content: JSON.stringify({}), model: env.groqModel } },
    { name: "missing draft", providerValue: { content: JSON.stringify({ confidence: 0.9 }), model: env.groqModel } },
    { name: "draft as number", providerValue: { content: JSON.stringify({ draft: 5 }), model: env.groqModel } },
    { name: "draft as object", providerValue: { content: JSON.stringify({ draft: { text: "hi" } }), model: env.groqModel } },
    { name: "draft empty string", providerValue: { content: JSON.stringify({ draft: "" }), model: env.groqModel } },
    { name: "draft whitespace only", providerValue: { content: JSON.stringify({ draft: "   \n\t  " }), model: env.groqModel } },
  ];

  for (const { name, providerValue } of cases) {
    const before = await replyDraftCountForTicket(ticketA.id);
    const beforeComments = await commentCountForTicket(ticketA.id);

    let res;
    await withMockedProvider(providerValue, async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
        method: "POST",
        cookie: agent1Cookie,
      });
    });

    assert.equal(res.status, 502, `${name}: expected 502`);
    assert.equal(res.body.status, "error", `${name}: error envelope expected`);
    assert.equal(
      await replyDraftCountForTicket(ticketA.id),
      before,
      `${name}: no suggestion row may be stored`,
    );
    assert.equal(
      await commentCountForTicket(ticketA.id),
      beforeComments,
      `${name}: no comment row may be created`,
    );
  }
});

test("oversized drafts are length-capped, not rejected", async () => {
  const draft = "a".repeat(5000);
  let res;
  await withMockedProvider(
    { content: JSON.stringify({ draft }), model: env.groqModel },
    async () => {
      res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
        method: "POST",
        cookie: agent1Cookie,
      });
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.data.suggestion.result.draft.length, 4000);
});

// ---------------------------------------------------------------------------
// Tests: Provider failures propagate safely and store nothing
// ---------------------------------------------------------------------------

test("provider timeout maps to 504 and stores nothing", async () => {
  const before = await replyDraftCountForTicket(ticketA.id);
  const beforeComments = await commentCountForTicket(ticketA.id);
  await withMockedProvider(new ApiError(504, "AI provider request timed out."), async () => {
    const res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
      method: "POST",
      cookie: agent1Cookie,
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.status, "error");
    assert.match(res.body.message, /timed out/i);
  });
  assert.equal(await replyDraftCountForTicket(ticketA.id), before);
  assert.equal(await commentCountForTicket(ticketA.id), beforeComments);
});

test("provider rate limit maps to 429 and stores nothing", async () => {
  await withMockedProvider(new ApiError(429, "AI provider is rate limited."), async () => {
    const res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
      method: "POST",
      cookie: agent1Cookie,
    });
    assert.equal(res.status, 429);
    assert.match(res.body.message, /rate limited/i);
  });
});

test("provider unavailability maps to 502 and stores nothing", async () => {
  await withMockedProvider(new ApiError(502, "AI provider is temporarily unavailable."), async () => {
    const res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
      method: "POST",
      cookie: agent1Cookie,
    });
    assert.equal(res.status, 502);
  });
});

test("reply-draft generation returns 503 when the provider is not configured", async () => {
  const originalConfigured = aiProvider.isConfigured;
  aiProvider.isConfigured = () => false;
  try {
    const res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
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
    const before = await replyDraftCountForTicket(ticketA.id);
    let res;
    await withMockedProvider(
      replyDraftResponse("Hi, we are investigating the issue."),
      async () => {
        res = await request(`/api/v1/tickets/${ticketA.id}/ai/reply-draft`, {
          method: "POST",
          cookie: adminCookie,
        });
      },
    );
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.equal(res.body.message, "Internal server error");
    assert.equal(await replyDraftCountForTicket(ticketA.id), before);
  } finally {
    database.query = originalQuery;
  }
});
