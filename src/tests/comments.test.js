/**
 * Integration test suite for ticket comments under /api/v1/tickets/:id/comments
 *
 * Covers:
 *  - Authentication (401) and ticket access scoping (403) for both routes
 *  - POST: customer adds a comment to own ticket (FR-012), defaults,
 *    response shape, message trimming, DB persistence
 *  - POST: customer cannot set is_internal (403), no DB row
 *  - POST: agent comments only on assigned tickets (FR-023),
 *    including internal notes (is_internal: true)
 *  - POST: admin can comment on any ticket, including internal notes
 *  - POST: customers may still comment when the ticket is CLOSED
 *    (no status restriction is documented for comments)
 *  - GET: customer sees own thread without internal comments,
 *    agent/admin see everything (FR-022)
 *  - Ordering: chronological (oldest first)
 *  - Validation: 422 empty/blank/non-string/unknown fields, 400 malformed
 *    JSON, 400 invalid ids, 404 missing ticket
 *
 * Run: node --test src/tests/comments.test.js
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";

let server;
let baseUrl;

// Test users
let adminUser;
let agent1User;
let agent2User;
let customer1User;
let customer2User;

// Session cookies
let adminCookie;
let agent1Cookie;
let agent2Cookie;
let customer1Cookie;
let customer2Cookie;

let agent1Id;

// Tickets created during the tests
let ticketMain; // customer1 — main comment thread
let ticketOther; // customer2 — access isolation checks
let ticketClosed; // customer1 — closed-state commenting behavior

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

  // Ensure case-insensitive unique category index exists (matches other suites)
  await database.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique_ci ON categories (LOWER(name))",
  );

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
    `admin_${timestamp}@comments.example.com`,
    "ADMIN",
  );
  agent1User = await createUser(
    `Agent1_${timestamp}`,
    `agent1_${timestamp}@comments.example.com`,
    "AGENT",
  );
  agent2User = await createUser(
    `Agent2_${timestamp}`,
    `agent2_${timestamp}@comments.example.com`,
    "AGENT",
  );
  customer1User = await createUser(
    `Customer1_${timestamp}`,
    `customer1_${timestamp}@comments.example.com`,
    "CUSTOMER",
  );
  customer2User = await createUser(
    `Customer2_${timestamp}`,
    `customer2_${timestamp}@comments.example.com`,
    "CUSTOMER",
  );

  agent1Id = String(agent1User.id);

  adminCookie = await loginAndGetCookie(port, adminUser.email, "TestPass1!");
  agent1Cookie = await loginAndGetCookie(port, agent1User.email, "TestPass1!");
  agent2Cookie = await loginAndGetCookie(port, agent2User.email, "TestPass1!");
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

  const cat = (await request("/api/v1/categories", {
    method: "POST",
    cookie: adminCookie,
    body: { name: `Comments_${timestamp}` },
  })).body.data.category;

  async function createTicket(cookie, body) {
    const { status, body: resBody } = await request("/api/v1/tickets", {
      method: "POST",
      cookie,
      body,
    });
    assert.equal(
      status,
      201,
      `Ticket creation failed: ${JSON.stringify(resBody)}`,
    );
    return resBody.data.ticket;
  }

  ticketMain = await createTicket(customer1Cookie, {
    title: "Printer jams on double-sided",
    description: "Every duplex job stops halfway through.",
    category_id: cat.id,
  });

  ticketOther = await createTicket(customer2Cookie, {
    title: "Export stops at 90%",
    description: "The progress bar freezes before completion.",
  });

  ticketClosed = await createTicket(customer1Cookie, {
    title: "Password reset loop",
    description: "Reset email arrives twice and then fails.",
  });
  const closed = await request(`/api/v1/tickets/${ticketClosed.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "CLOSED" },
  });
  assert.equal(closed.status, 200);

  // Assign agent1 to the main ticket so the agent flows have a target
  const assign = await request(`/api/v1/tickets/${ticketMain.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent1Id },
  });
  assert.equal(assign.status, 200);
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

async function fetchCommentRows(ticketId) {
  const { rows } = await database.query(
    `SELECT c.id, c.ticket_id, c.author_id, c.message, c.is_internal,
            c.created_at, u.name AS author_name
     FROM ticket_comments c
     JOIN users u ON u.id = c.author_id
     WHERE c.ticket_id = $1
     ORDER BY c.id`,
    [ticketId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

test("unauthenticated comment requests return 401", async () => {
  const list = await request(`/api/v1/tickets/${ticketMain.id}/comments`);
  assert.equal(list.status, 401);

  const add = await request(`/api/v1/tickets/${ticketMain.id}/comments`, {
    method: "POST",
    body: { message: "No session" },
  });
  assert.equal(add.status, 401);
});

// ---------------------------------------------------------------------------
// Tests: POST — customer adds a comment to own ticket (FR-012)
// ---------------------------------------------------------------------------

test("customer can add a comment to their own ticket (201)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "  It only happens with the tray on the back.  " },
    },
  );
  assert.equal(status, 201);
  assert.equal(body.status, "success");

  const comment = body.data.comment;
  assert.ok(comment.id);
  assert.equal(String(comment.ticket_id), String(ticketMain.id));
  assert.equal(String(comment.author_id), String(customer1User.id));
  assert.equal(comment.author.name, customer1User.name);
  assert.equal(comment.message, "It only happens with the tray on the back.");
  assert.equal(comment.is_internal, false);
  assert.ok(comment.created_at);
  assert.ok(comment.updated_at);

  const rows = await fetchCommentRows(ticketMain.id);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].author_id), String(customer1User.id));
  assert.equal(rows[0].is_internal, false);
});

test("comment is_internal defaults to false", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Waiting for a fix." },
    },
  );
  assert.equal(status, 201);
  assert.equal(body.data.comment.is_internal, false);
});

test("customer cannot set is_internal on their comment (403, no row)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Trying to hide this one.", is_internal: true },
    },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");

  const rows = await fetchCommentRows(ticketMain.id);
  assert.ok(
    !rows.some((r) => r.message === "Trying to hide this one."),
    "Rejected internal comments must not be inserted",
  );
});

test("is_internal: false from a customer is accepted", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Also attaching logs.", is_internal: false },
    },
  );
  assert.equal(status, 201);
  assert.equal(body.data.comment.is_internal, false);
});

// ---------------------------------------------------------------------------
// Tests: POST — access scoping
// ---------------------------------------------------------------------------

test("customer cannot comment on another customer's ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketOther.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Not mine." },
    },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
  assert.equal((await fetchCommentRows(ticketOther.id)).length, 0);
});

test("unassigned agent cannot comment (403)", async () => {
  const { status } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: agent2Cookie,
      body: { message: "I am not assigned." },
    },
  );
  assert.equal(status, 403);
});

test("unassigned agent cannot list comments (403)", async () => {
  const { status } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    { cookie: agent2Cookie },
  );
  assert.equal(status, 403);
});

test("assigned agent can post a public response (FR-023)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: agent1Cookie,
      body: { message: "Thanks, could you try the front tray?" },
    },
  );
  assert.equal(status, 201);
  assert.equal(String(body.data.comment.author_id), agent1Id);
  assert.equal(body.data.comment.is_internal, false);
});

test("assigned agent can post an internal note", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: agent1Cookie,
      body: {
        message: "Hardware ticket — probable duplex unit failure.",
        is_internal: true,
      },
    },
  );
  assert.equal(status, 201);
  assert.equal(body.data.comment.is_internal, true);

  const internalRows = (await fetchCommentRows(ticketMain.id)).filter(
    (r) => r.is_internal,
  );
  assert.ok(internalRows.length >= 1, "internal note must be stored");
});

test("assigned agent sees the full thread including internal notes (FR-022)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    { cookie: agent1Cookie },
  );
  assert.equal(status, 200);

  const messages = body.data.comments.map((c) => c.message);
  assert.ok(
    messages.includes("Hardware ticket — probable duplex unit failure."),
    "Agent must see internal comments",
  );
  assert.ok(
    messages.includes("It only happens with the tray on the back."),
    "Agent must see customer comments",
  );
});

test("admin can comment on any ticket, also internally", async () => {
  const own = await request(`/api/v1/tickets/${ticketOther.id}/comments`, {
    method: "POST",
    cookie: adminCookie,
    body: { message: "Checking on this for the customer." },
  });
  assert.equal(own.status, 201);
  assert.equal(own.body.data.comment.is_internal, false);

  const internal = await request(`/api/v1/tickets/${ticketOther.id}/comments`, {
    method: "POST",
    cookie: adminCookie,
    body: { message: "Escalating to vendor.", is_internal: true },
  });
  assert.equal(internal.status, 201);
  assert.equal(internal.body.data.comment.is_internal, true);
});

test("customers cannot see internal comments in the thread", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    { cookie: customer1Cookie },
  );
  assert.equal(status, 200);

  for (const comment of body.data.comments) {
    assert.equal(
      comment.is_internal,
      false,
      "Customer responses must never contain internal comments",
    );
  }
  const messages = body.data.comments.map((c) => c.message);
  assert.ok(
    !messages.includes("Hardware ticket — probable duplex unit failure."),
  );
  assert.ok(messages.includes("Thanks, could you try the front tray?"));
});

test("admin list returns internal comments too", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketOther.id}/comments`,
    { cookie: adminCookie },
  );
  assert.equal(status, 200);
  const messages = body.data.comments.map((c) => c.message);
  assert.ok(messages.includes("Escalating to vendor."));
});

// ---------------------------------------------------------------------------
// Tests: POST — no status restriction on comments (documented behavior)
// ---------------------------------------------------------------------------

test("customer can still comment on own CLOSED ticket (FR-012)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketClosed.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Same problem happened again today." },
    },
  );
  assert.equal(status, 201);
  assert.equal(String(body.data.comment.ticket_id), String(ticketClosed.id));
});

// ---------------------------------------------------------------------------
// Tests: GET — empty thread, ordering
// ---------------------------------------------------------------------------

test("ticket with no comments returns an empty list (200)", async () => {
  const fresh = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer2Cookie,
    body: {
      title: "Fresh empty thread",
      description: "No comments have been posted yet.",
    },
  });
  assert.equal(fresh.status, 201);

  const { status, body } = await request(
    `/api/v1/tickets/${fresh.body.data.ticket.id}/comments`,
    { cookie: customer2Cookie },
  );
  assert.equal(status, 200);
  assert.deepEqual(body.data.comments, []);
});

test("comments are returned oldest first", async () => {
  const list = await request(`/api/v1/tickets/${ticketMain.id}/comments`, {
    cookie: agent1Cookie,
  });
  assert.equal(list.status, 200);
  const ids = list.body.data.comments.map((c) => String(c.id));
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(ids, sorted);
});

// ---------------------------------------------------------------------------
// Tests: 404 / 400 for the :id parameter
// ---------------------------------------------------------------------------

test("comments on a missing ticket return 404", async () => {
  const list = await request("/api/v1/tickets/99999999/comments", {
    cookie: adminCookie,
  });
  assert.equal(list.status, 404);

  const add = await request("/api/v1/tickets/99999999/comments", {
    method: "POST",
    cookie: adminCookie,
    body: { message: "Nowhere to go." },
  });
  assert.equal(add.status, 404);
});

test("comment endpoints reject invalid ticket ids with 400", async () => {
  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const list = await request(`/api/v1/tickets/${bad}/comments`, {
      cookie: adminCookie,
    });
    assert.equal(list.status, 400, `Expected 400 for id "${bad}"`);

    const add = await request(`/api/v1/tickets/${bad}/comments`, {
      method: "POST",
      cookie: adminCookie,
      body: { message: "Bad id" },
    });
    assert.equal(add.status, 400, `Expected 400 for id "${bad}"`);
  }
});

// ---------------------------------------------------------------------------
// Tests: request body validation (422 / 400)
// ---------------------------------------------------------------------------

test("comment validation rejects empty, missing, and blank messages (422)", async () => {
  const cases = [
    {},
    { message: "" },
    { message: "   " },
    { message: 42 },
    { message: null },
  ];
  for (const body of cases) {
    const { status, body: resBody } = await request(
      `/api/v1/tickets/${ticketMain.id}/comments`,
      {
        method: "POST",
        cookie: customer1Cookie,
        body,
      },
    );
    assert.equal(status, 422, `Expected 422 for ${JSON.stringify(body)}`);
    assert.ok(
      resBody.errors.some(
        (e) => e.field === "message" || e.field === "_body",
      ),
      `Expected a message (or empty-body) error for ${JSON.stringify(body)}`,
    );
    assert.equal(resBody.status, "error");
  }
});

test("comment validation rejects unknown fields and bad is_internal (422)", async () => {
  const unknown = await request(`/api/v1/tickets/${ticketMain.id}/comments`, {
    method: "POST",
    cookie: customer1Cookie,
    body: { message: "Unknown field", ticket_id: 1 },
  });
  assert.equal(unknown.status, 422);
  assert.ok(unknown.body.errors.some((e) => e.field === "ticket_id"));

  const spoofAuthor = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "Spoof author", author_id: agent1Id },
    },
  );
  assert.equal(spoofAuthor.status, 422);
  assert.ok(spoofAuthor.body.errors.some((e) => e.field === "author_id"));

  const malformedInternal = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      body: { message: "String flag", is_internal: "false" },
    },
  );
  assert.equal(malformedInternal.status, 422);
  assert.ok(
    malformedInternal.body.errors.some((e) => e.field === "is_internal"),
  );
});

test("comment endpoint rejects an empty request body (422)", async () => {
  const { status } = await request(`/api/v1/tickets/${ticketMain.id}/comments`, {
    method: "POST",
    cookie: customer1Cookie,
    body: {},
  });
  assert.equal(status, 422);
});

test("comment endpoint rejects malformed JSON with 400", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticketMain.id}/comments`,
    {
      method: "POST",
      cookie: customer1Cookie,
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    },
  );
  assert.equal(status, 400);
  assert.equal(body.status, "error");
});
