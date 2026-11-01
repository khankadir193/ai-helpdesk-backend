/**
 * Integration test suite for Ticket management under /api/v1/tickets
 *
 * Covers:
 *  - Authentication (401s) and role-based route authorization (403s)
 *  - POST /tickets: creation, defaults, validation (422/400), category rules,
 *    inactive category rejection, missing category
 *  - GET /tickets/:id: ownership scoping, 404s, invalid ids
 *  - PATCH /tickets/:id: customer/agent/admin edit permissions, edit lock
 *    after OPEN, category clearing, no-change updates, unknown fields
 *  - PATCH /tickets/:id/status: transition matrix, resolved_at/closed_at
 *    timestamps, terminal CLOSED state
 *  - PATCH /tickets/:id/assignment: admin only, agent validation, unassign
 *  - GET /tickets/:id/history: audit records created by all mutations
 *  - GET /tickets: role scoping, filters, sorting, pagination
 *  - Requirement: existing tickets stay readable when their category is
 *    deactivated
 *  - Database errors (500 envelope)
 *
 * Run: node --test src/tests/tickets.test.js
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
let agentDeactivated;
let customer1User;
let customer2User;

// Session cookies
let adminCookie;
let agent1Cookie;
let agent2Cookie;
let customer1Cookie;
let customer2Cookie;

// Categories referenced across suites
let catActive;
let catInactive;
let catOther;
let catKeep;

// Tickets created during the tests (ids are strings from the pg driver)
let ticket01; // customer1 — main subject for customer details/edits
let ticket02; // customer1 — defaults test (no category/priority)
let ticket03; // customer2 — assignment cycle, full status lifecycle
let ticket04; // customer1 — keep-category deactivation preservation
let ticket06; // customer2 — OPEN -> CLOSED terminal-state checks

let agent1Id;
let agent2Id;

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
    `admin_${timestamp}@tickets.example.com`,
    "ADMIN",
  );
  agent1User = await createUser(
    `Agent1_${timestamp}`,
    `agent1_${timestamp}@tickets.example.com`,
    "AGENT",
  );
  agent2User = await createUser(
    `Agent2_${timestamp}`,
    `agent2_${timestamp}@tickets.example.com`,
    "AGENT",
  );
  agentDeactivated = await createUser(
    `AgentDeact_${timestamp}`,
    `agentdeact_${timestamp}@tickets.example.com`,
    "AGENT",
  );
  customer1User = await createUser(
    `Customer1_${timestamp}`,
    `customer1_${timestamp}@tickets.example.com`,
    "CUSTOMER",
  );
  customer2User = await createUser(
    `Customer2_${timestamp}`,
    `customer2_${timestamp}@tickets.example.com`,
    "CUSTOMER",
  );

  // Deactivate one agent for assignment validation tests
  await database.query(
    "UPDATE users SET is_active = false WHERE id = $1",
    [agentDeactivated.id],
  );

  agent1Id = String(agent1User.id);
  agent2Id = String(agent2User.id);

  adminCookie = await loginAndGetCookie(port, adminUser.email, "TestPass1!");
  agent1Cookie = await loginAndGetCookie(port, agent1User.email, "TestPass1!");
  agent2Cookie = await loginAndGetCookie(port, agent2User.email, "TestPass1!");
  // Deactivated agent cannot obtain a session (login is blocked) — no cookie needed
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

  // Categories: two active (one for creation + one as a re-assignment target),
  // one inactive from the start, and one active that we later disable.
  catActive = (await request("/api/v1/categories", {
    method: "POST",
    cookie: adminCookie,
    body: { name: `Printer_${timestamp}` },
  })).body.data.category;
  catOther = (await request("/api/v1/categories", {
    method: "POST",
    cookie: adminCookie,
    body: { name: `Account_${timestamp}` },
  })).body.data.category;
  catInactive = (await request("/api/v1/categories", {
    method: "POST",
    cookie: adminCookie,
    body: { name: `Legacy_${timestamp}`, is_active: false },
  })).body.data.category;
  catKeep = (await request("/api/v1/categories", {
    method: "POST",
    cookie: adminCookie,
    body: { name: `Preserve_${timestamp}` },
  })).body.data.category;
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

async function createTicket(cookie, body) {
  const { status, body: resBody } = await request("/api/v1/tickets", {
    method: "POST",
    cookie,
    body,
  });
  assert.equal(status, 201, `Ticket creation failed: ${JSON.stringify(resBody)}`);
  return resBody.data.ticket;
}

async function fetchTicketRow(id) {
  const { rows } = await database.query(
    "SELECT * FROM tickets WHERE id = $1",
    [id],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

test("unauthenticated requests to ticket endpoints return 401", async () => {
  const post = await request("/api/v1/tickets", {
    method: "POST",
    body: { title: "No session", description: "No session" },
  });
  assert.equal(post.status, 401);

  const list = await request("/api/v1/tickets");
  assert.equal(list.status, 401);

  const detail = await request("/api/v1/tickets/1");
  assert.equal(detail.status, 401);
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/tickets — role gate and successful creation
// ---------------------------------------------------------------------------

test("agent cannot create tickets (403)", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: agent1Cookie,
    body: { title: "Agent attempt", description: "Agent attempt" },
  });
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("admin cannot create tickets via customer endpoint (403)", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: adminCookie,
    body: { title: "Admin attempt", description: "Admin attempt" },
  });
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("customer can create a ticket with category and priority", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {
      title: "Cannot sign in with SSO",
      description: "The single sign-on redirect fails with error 500.",
      category_id: catActive.id,
      priority: "HIGH",
    },
  });

  assert.equal(status, 201);
  assert.equal(body.status, "success");
  const ticket = body.data.ticket;
  assert.ok(ticket.id);
  assert.equal(ticket.title, "Cannot sign in with SSO");
  assert.equal(ticket.status, "OPEN");
  assert.equal(ticket.priority, "HIGH");
  assert.equal(String(ticket.customer_id), String(customer1User.id));
  assert.equal(String(ticket.category_id), String(catActive.id));
  assert.equal(ticket.assigned_agent_id, null);
  assert.equal(ticket.customer.email, customer1User.email);
  assert.equal(ticket.category.name, catActive.name);
  assert.equal(ticket.category.is_active, true);
  assert.ok(ticket.created_at);
  assert.ok(ticket.updated_at);

  ticket01 = ticket;
});

test("ticket honors DB defaults when category/priority omitted", async () => {
  const ticket = await createTicket(customer1Cookie, {
    title: "Small annoyance",
    description: "Button overlaps text on the dashboard.",
  });
  assert.equal(ticket.status, "OPEN");
  assert.equal(ticket.priority, "MEDIUM");
  assert.equal(ticket.category_id, null);
  assert.equal(ticket.category, null);
  ticket02 = ticket;
});

test("creating a ticket records a TICKET_CREATED history entry", async () => {
  const row = await fetchTicketRow(ticket01.id);
  const { rows } = await database.query(
    "SELECT action, field_name, old_value, new_value FROM ticket_history WHERE ticket_id = $1 ORDER BY id",
    [row.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "TICKET_CREATED");
  assert.equal(rows[0].field_name, "status");
  assert.equal(rows[0].old_value, null);
  assert.equal(rows[0].new_value, "OPEN");
});

test("customer cannot spoof customer_id ownership via unknown body field", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer2Cookie,
    body: {
      title: "Hijack attempt",
      description: "Trying to create on behalf of another user",
      customer_id: agent1Id,
    },
  });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.field === "customer_id"));
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/tickets — category rules (missing / inactive / invalid)
// ---------------------------------------------------------------------------

test("creating a ticket with a nonexistent category returns 404", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {
      title: "Bad category",
      description: "Reference to a category that does not exist",
      category_id: 99999999,
    },
  });
  assert.equal(status, 404);
  assert.equal(body.status, "error");
});

test("creating a ticket with an inactive category returns 400", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {
      title: "Inactive category",
      description: "Should be rejected for new tickets",
      category_id: catInactive.id,
    },
  });
  assert.equal(status, 400);
  assert.match(body.message, /inactive/i);
});

test("creating a ticket with malformed category ids returns 400", async () => {
  for (const bad of ["abc", -1, 1.5]) {
    const { status, body } = await request("/api/v1/tickets", {
      method: "POST",
      cookie: customer1Cookie,
      body: {
        title: "Bad category id",
        description: "Malformed category id",
        category_id: bad,
      },
    });
    assert.equal(status, 400, `Expected 400 for category_id ${JSON.stringify(bad)}`);
    assert.equal(body.status, "error");
  }
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/tickets — request body validation
// ---------------------------------------------------------------------------

test("ticket creation rejects missing/blank/oversized title with 422", async () => {
  const cases = [
    { title: undefined, description: "Desc" },
    { title: "   ", description: "Desc" },
    { title: "A".repeat(201), description: "Desc" },
  ];
  for (const body of cases) {
    const { status, body: resBody } = await request("/api/v1/tickets", {
      method: "POST",
      cookie: customer1Cookie,
      body,
    });
    assert.equal(status, 422);
    assert.ok(
      resBody.errors.some((e) => e.field === "title"),
      `Expected a title error for ${JSON.stringify(body)}`,
    );
  }
});

test("ticket creation rejects missing/blank description with 422", async () => {
  const cases = [{ title: "T", description: undefined }, { title: "T", description: "" }];
  for (const body of cases) {
    const { status, body: resBody } = await request("/api/v1/tickets", {
      method: "POST",
      cookie: customer1Cookie,
      body,
    });
    assert.equal(status, 422);
    assert.ok(resBody.errors.some((e) => e.field === "description"));
  }
});

test("ticket creation rejects invalid priority values with 422", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {
      title: "Bad priority",
      description: "Description",
      priority: "CRITICAL",
    },
  });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.field === "priority"));
});

test("ticket creation rejects unknown fields with 422", async () => {
  const { status, body } = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {
      title: "Unknown field",
      description: "Trying to inject status on creation",
      status: "CLOSED",
      assigned_agent_id: agent1Id,
    },
  });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.field === "status"));
  assert.ok(body.errors.some((e) => e.field === "assigned_agent_id"));
});

test("ticket creation rejects empty and malformed bodies", async () => {
  const empty = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    body: {},
  });
  assert.equal(empty.status, 422);

  const malformed = await request("/api/v1/tickets", {
    method: "POST",
    cookie: customer1Cookie,
    headers: { "Content-Type": "application/json" },
    body: "{ not json",
  });
  assert.equal(malformed.status, 400);
});

test("second customer can create their own ticket", async () => {
  ticket03 = await createTicket(customer2Cookie, {
    title: "Report export fails",
    description: "Monthly export returns an empty file.",
    category_id: catActive.id,
  });
  assert.equal(String(ticket03.customer_id), String(customer2User.id));
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/tickets/:id — ownership scoping
// ---------------------------------------------------------------------------

test("customer can view their own ticket (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    { cookie: customer1Cookie },
  );
  assert.equal(status, 200);
  assert.equal(String(body.data.ticket.id), String(ticket01.id));
  assert.equal(body.data.ticket.description, "The single sign-on redirect fails with error 500.");
  assert.ok(body.data.ticket.customer);
  assert.equal(body.data.ticket.assigned_agent, null);
});

test("customer cannot view another customer's ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    { cookie: customer2Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("unassigned agents cannot view tickets (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    { cookie: agent2Cookie },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("admin can view any ticket (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    { cookie: adminCookie },
  );
  assert.equal(status, 200);
  assert.equal(String(body.data.ticket.id), String(ticket01.id));
});

test("GET /tickets/:id misc: 404 and invalid id 400", async () => {
  const missing = await request("/api/v1/tickets/99999999", {
    cookie: adminCookie,
  });
  assert.equal(missing.status, 404);

  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const { status, body } = await request(`/api/v1/tickets/${bad}`, {
      cookie: adminCookie,
    });
    assert.equal(status, 400, `Expected 400 for id "${bad}"`);
    assert.equal(body.status, "error");
  }
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/v1/tickets/:id — detail edits and permissions
// ---------------------------------------------------------------------------

test("customer can edit title/description of their own OPEN ticket (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: {
        title: "Cannot sign in with SSO (updated)",
        description: "Second sign-in attempt also fails with error 502.",
      },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.title, "Cannot sign in with SSO (updated)");
  assert.equal(
    body.data.ticket.description,
    "Second sign-in attempt also fails with error 502.",
  );
});

test("other customer cannot edit the ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer2Cookie,
      body: { title: "Hijack" },
    },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("admin can edit any non-closed ticket (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { priority: "URGENT", title: "Cannot sign in with SSO (escalated)" },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.priority, "URGENT");
});

test("unassigned agent cannot edit a ticket (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: agent2Cookie,
      body: { priority: "LOW" },
    },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("customer can move category to another active category (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: { category_id: catOther.id },
    },
  );
  assert.equal(status, 200);
  assert.equal(String(body.data.ticket.category_id), String(catOther.id));
});

test("customer cannot move category to an inactive category (400)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: { category_id: catInactive.id },
    },
  );
  assert.equal(status, 400);
  assert.match(body.message, /inactive/i);
});

test("moving category to a nonexistent category returns 404", async () => {
  const { status } = await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: { category_id: 99999999 },
  });
  assert.equal(status, 404);
});

test("customer can clear the category of their ticket (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: { category_id: null },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.category_id, null);
  assert.equal(body.data.ticket.category, null);
});

test("PATCH with unchanged field is a no-op that succeeds (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: { title: "Cannot sign in with SSO (escalated)" },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.title, "Cannot sign in with SSO (escalated)");
});

test("PATCH body with same value as current produces no history row", async () => {
  const { rows: before } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_history WHERE ticket_id = $1",
    [ticket01.id],
  );
  await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: { title: "Cannot sign in with SSO (escalated)" },
  });
  const { rows: afterRows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM ticket_history WHERE ticket_id = $1",
    [ticket01.id],
  );
  assert.equal(afterRows[0].n, before[0].n);
});

test("PATCH rejects empty body, unknown fields, and status manipulation", async () => {
  const empty = await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: {},
  });
  assert.equal(empty.status, 422);

  const unknown = await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: { status: "CLOSED" },
  });
  assert.equal(unknown.status, 422);
  assert.ok(unknown.body.errors.some((e) => e.field === "status"));

  const assignment = await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: { priority: "LOW", assigned_agent_id: agent1Id },
  });
  assert.equal(assignment.status, 422);
  assert.ok(assignment.body.errors.some((e) => e.field === "assigned_agent_id"));

  const blank = await request(`/api/v1/tickets/${ticket01.id}`, {
    method: "PATCH",
    cookie: customer1Cookie,
    body: { description: "   " },
  });
  assert.equal(blank.status, 422);
});

test("PATCH on nonexistent ticket returns 404", async () => {
  const { status } = await request("/api/v1/tickets/99999999", {
    method: "PATCH",
    cookie: adminCookie,
    body: { title: "Missing" },
  });
  assert.equal(status, 404);
});

// Self-closed tickets cannot be edited — covered after the CLOSED flow below.

// ---------------------------------------------------------------------------
// Tests: PATCH /api/v1/tickets/:id/assignment — admin assignment cycle
// ---------------------------------------------------------------------------

test("agents and customers cannot assign tickets (403)", async () => {
  const agentTry = await request(`/api/v1/tickets/${ticket03.id}/assignment`, {
    method: "PATCH",
    cookie: agent1Cookie,
    body: { assigned_agent_id: agent1Id },
  });
  assert.equal(agentTry.status, 403);

  const customerTry = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    { method: "PATCH", cookie: customer2Cookie, body: { assigned_agent_id: agent1Id } },
  );
  assert.equal(customerTry.status, 403);
});

test("admin can assign an agent; agent then becomes a manager of the ticket", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: agent1Id },
    },
  );
  assert.equal(status, 200);
  assert.equal(String(body.data.ticket.assigned_agent_id), agent1Id);
  assert.equal(body.data.ticket.assigned_agent.name, agent1User.name);

  const detail = await request(`/api/v1/tickets/${ticket03.id}`, {
    cookie: agent1Cookie,
  });
  assert.equal(detail.status, 200);
});

test("assigned agent can edit priority but not title/description", async () => {
  const priority = await request(`/api/v1/tickets/${ticket03.id}`, {
    method: "PATCH",
    cookie: agent1Cookie,
    body: { priority: "LOW" },
  });
  assert.equal(priority.status, 200);
  assert.equal(priority.body.data.ticket.priority, "LOW");

  for (const field of ["title", "description"]) {
    const attempt = await request(`/api/v1/tickets/${ticket03.id}`, {
      method: "PATCH",
      cookie: agent1Cookie,
      body: { [field]: "Agent rewrite" },
    });
    assert.equal(attempt.status, 403, `Agents must not edit ${field}`);
  }
});

test("assignment to a customer-role user returns 400", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: String(customer1User.id) },
    },
  );
  assert.equal(status, 400);
  assert.match(body.message, /AGENT role/i);
});

test("assignment to a nonexistent user returns 404", async () => {
  const { status } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: 99999999 },
    },
  );
  assert.equal(status, 404);
});

test("assignment to a deactivated agent returns 400", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: String(agentDeactivated.id) },
    },
  );
  assert.equal(status, 400);
  assert.match(body.message, /deactivated/i);
});

test("assignment body validation returns 422/400", async () => {
  const missing = await request(`/api/v1/tickets/${ticket03.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: {},
  });
  assert.equal(missing.status, 422);

  const unknown = await request(`/api/v1/tickets/${ticket03.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent1Id, status: "OPEN" },
  });
  assert.equal(unknown.status, 422);

  const malformed = await request(`/api/v1/tickets/${ticket03.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: "abc" },
  });
  assert.equal(malformed.status, 400);
});

test("admin can reassign the ticket to another agent (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: agent2Id },
    },
  );
  assert.equal(status, 200);
  assert.equal(String(body.data.ticket.assigned_agent_id), agent2Id);

  // Previous agent loses access (FR-028), new agent gains it
  const previous = await request(`/api/v1/tickets/${ticket03.id}`, {
    cookie: agent1Cookie,
  });
  assert.equal(previous.status, 403);

  const now = await request(`/api/v1/tickets/${ticket03.id}`, {
    cookie: agent2Cookie,
  });
  assert.equal(now.status, 200);
});

test("admin can unassign a ticket with null (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/assignment`,
    {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: null },
    },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.assigned_agent_id, null);
  assert.equal(body.data.ticket.assigned_agent, null);

  const detail = await request(`/api/v1/tickets/${ticket03.id}`, {
    cookie: agent2Cookie,
  });
  assert.equal(detail.status, 403, "Agent must lose access after unassignment");
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/v1/tickets/:id/status — transitions and permissions
// ---------------------------------------------------------------------------

test("customers cannot use the status endpoint (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}/status`,
    { method: "PATCH", cookie: customer1Cookie, body: { status: "IN_PROGRESS" } },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("unassigned agents cannot change status (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}/status`,
    { method: "PATCH", cookie: agent2Cookie, body: { status: "IN_PROGRESS" } },
  );
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("unknown status values are rejected with 422", async () => {
  const missing = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: {},
  });
  assert.equal(missing.status, 422);

  const bogus = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "PENDING" },
  });
  assert.equal(bogus.status, 422);
  assert.ok(bogus.body.errors.some((e) => e.field === "status"));

  const unknownField = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "OPEN", priority: "LOW" },
  });
  assert.equal(unknownField.status, 422);
  assert.ok(unknownField.body.errors.some((e) => e.field === "priority"));
});

test("admin can transition any ticket OPEN -> IN_PROGRESS (200)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}/status`,
    { method: "PATCH", cookie: adminCookie, body: { status: "IN_PROGRESS" } },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.status, "IN_PROGRESS");
  assert.equal(body.data.ticket.resolved_at, null);
});

test("customer cannot edit ticket once it left OPEN (403)", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket01.id}`,
    {
      method: "PATCH",
      cookie: customer1Cookie,
      body: { title: "Staff changed my status" },
    },
  );
  assert.equal(status, 403);
  assert.match(body.message, /OPEN/i);
});

test("full lifecycle on assigned ticket keeps resolved/closed timestamps consistent", async () => {
  // OPEN -> IN_PROGRESS (agent restores assignment first? No — t3 was
  // unassigned above; admin assigns agent2 for the lifecycle.)
  const assign = await request(`/api/v1/tickets/${ticket03.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent2Id },
  });
  assert.equal(assign.status, 200);

  const toProgress = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "IN_PROGRESS" },
  });
  assert.equal(toProgress.status, 200);
  assert.equal(toProgress.body.data.ticket.status, "IN_PROGRESS");

  // same-status transition is rejected
  const noop = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "IN_PROGRESS" },
  });
  assert.equal(noop.status, 409);
  assert.match(noop.body.message, /Invalid status transition/);

  const toResolved = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "RESOLVED" },
  });
  assert.equal(toResolved.status, 200);
  assert.ok(toResolved.body.data.ticket.resolved_at, "resolved_at must be stamped");
  assert.equal(toResolved.body.data.ticket.closed_at, null);

  const reopened = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "OPEN" },
  });
  assert.equal(reopened.status, 200);
  assert.equal(
    reopened.body.data.ticket.resolved_at,
    null,
    "resolved_at must be cleared on reopen",
  );

  const resolvedAgain = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "RESOLVED" },
  });
  assert.equal(resolvedAgain.status, 200);
  const resolvedAt = resolvedAgain.body.data.ticket.resolved_at;
  assert.ok(resolvedAt);

  const closed = await request(`/api/v1/tickets/${ticket03.id}/status`, {
    method: "PATCH",
    cookie: agent2Cookie,
    body: { status: "CLOSED" },
  });
  assert.equal(closed.status, 200);
  assert.ok(closed.body.data.ticket.closed_at);
  assert.equal(
    closed.body.data.ticket.resolved_at,
    resolvedAt,
    "RESOLVED -> CLOSED keeps the original resolved_at",
  );

  const row = await fetchTicketRow(ticket03.id);
  assert.equal(row.status, "CLOSED");
  assert.ok(row.resolved_at);
  assert.ok(row.closed_at);
});

test("invalid transitions are rejected with 409", async () => {
  // OPEN -> OPEN on a fresh open ticket (ticket02)
  const noop = await request(`/api/v1/tickets/${ticket02.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "OPEN" },
  });
  assert.equal(noop.status, 409);
  assert.match(noop.body.message, /OPEN/);
});

// ---------------------------------------------------------------------------
// Tests: requirement — tickets remain visible when their category is disabled
// ---------------------------------------------------------------------------

test("deactivating a category preserves access to existing tickets", async () => {
  ticket04 = await createTicket(customer1Cookie, {
    title: "Preserve this history",
    description: "This ticket references a category that will be disabled.",
    category_id: catKeep.id,
  });
  assert.equal(String(ticket04.category_id), String(catKeep.id));

  const deactivate = await request(
    `/api/v1/categories/${catKeep.id}/status`,
    { method: "PATCH", cookie: adminCookie, body: { is_active: false } },
  );
  assert.equal(deactivate.status, 200);

  const detail = await request(`/api/v1/tickets/${ticket04.id}`, {
    cookie: customer1Cookie,
  });
  assert.equal(detail.status, 200);
  assert.equal(String(detail.body.data.ticket.category_id), String(catKeep.id));
  assert.equal(detail.body.data.ticket.category.is_active, false);

  // Admin can still filter the ticket list by that (now inactive) category
  const adminList = await request(
    `/api/v1/tickets?category_id=${catKeep.id}`,
    { cookie: adminCookie },
  );
  assert.equal(adminList.status, 200);
  assert.ok(
    adminList.body.data.tickets.some(
      (t) => String(t.id) === String(ticket04.id),
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests: CLOSED tickets are terminal
// ---------------------------------------------------------------------------

test("OPEN -> CLOSED directly closes with both timestamps (and only then)", async () => {
  ticket06 = await createTicket(customer2Cookie, {
    title: "Duplicate shipment",
    description: "Received the order twice.",
  });

  const direct = await request(`/api/v1/tickets/${ticket06.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "CLOSED" },
  });
  assert.equal(direct.status, 200);
  assert.ok(direct.body.data.ticket.closed_at);
  assert.ok(
    direct.body.data.ticket.resolved_at,
    "DB constraint requires resolved_at for CLOSED tickets",
  );
});

test("CLOSED tickets reject every mutation with 409", async () => {
  const statusChange = await request(`/api/v1/tickets/${ticket06.id}/status`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { status: "OPEN" },
  });
  assert.equal(statusChange.status, 409);
  assert.match(statusChange.body.message, /CLOSED/i);

  const edit = await request(`/api/v1/tickets/${ticket06.id}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { title: "Too late" },
  });
  assert.equal(edit.status, 409);
  assert.match(edit.body.message, /CLOSED/i);

  const reassign = await request(`/api/v1/tickets/${ticket06.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent1Id },
  });
  assert.equal(reassign.status, 409);
  assert.match(reassign.body.message, /CLOSED/i);
});

test("customers keep read access to their CLOSED ticket", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket06.id}`,
    { cookie: customer2Cookie },
  );
  assert.equal(status, 200);
  assert.equal(body.data.ticket.status, "CLOSED");
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/tickets — list, filtering, sorting, pagination
// ---------------------------------------------------------------------------

test("customer list only includes their own tickets", async () => {
  const c1 = await request("/api/v1/tickets", { cookie: customer1Cookie });
  assert.equal(c1.status, 200);
  for (const ticket of c1.body.data.tickets) {
    assert.equal(String(ticket.customer_id), String(customer1User.id));
    assert.ok(
      [ticket01.id, ticket02.id, ticket04.id].map(String).includes(String(ticket.id)),
      "Customer1 must not see tickets they do not own",
    );
  }
  assert.ok(c1.body.data.tickets.length >= 3);

  const c2 = await request("/api/v1/tickets", { cookie: customer2Cookie });
  assert.equal(c2.status, 200);
  for (const ticket of c2.body.data.tickets) {
    assert.equal(String(ticket.customer_id), String(customer2User.id));
  }
  const c2Ids = c2.body.data.tickets.map((t) => String(t.id));
  assert.ok(c2Ids.includes(String(ticket03.id)));
  assert.ok(!c2Ids.includes(String(ticket01.id)));
});

test("agent list only includes assigned tickets", async () => {
  // Assign two tickets to agent2 so the list is meaningful
  const assign1 = await request(`/api/v1/tickets/${ticket06.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent2Id },
  });
  const urgent = await createTicket(customer2Cookie, {
    title: "Urgent outage",
    description: "Whole office cannot work because of the outage.",
    priority: "URGENT",
  });
  await request(`/api/v1/tickets/${urgent.id}/assignment`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { assigned_agent_id: agent2Id },
  });

  assert.equal(assign1.status, 409, "ticket06 is CLOSED — cannot be assigned");

  const list = await request("/api/v1/tickets", { cookie: agent2Cookie });
  assert.equal(list.status, 200);
  const ids = list.body.data.tickets.map((t) => String(t.id));
  assert.ok(ids.includes(String(urgent.id)), "Assigned ticket must be listed");
  assert.ok(ids.includes(String(ticket03.id)), "ticket03 was re-assigned to agent2");
  assert.ok(!ids.includes(String(ticket01.id)), "Unassigned tickets must not appear");
  // assignment attempts on CLOSED ticket06 must not have worked
  assert.ok(!ids.includes(String(ticket06.id)));
});

test("unassigned agent list is empty even though tickets exist", async () => {
  const list = await request("/api/v1/tickets", { cookie: agent1Cookie });
  assert.equal(list.status, 200);
  assert.equal(list.body.data.tickets.length, 0);
  assert.equal(list.body.data.pagination.total_items, 0);
  assert.equal(list.body.data.pagination.total_pages, 0);
});

test("admin list includes every ticket", async () => {
  const list = await request("/api/v1/tickets?limit=100", { cookie: adminCookie });
  assert.equal(list.status, 200);
  const ids = list.body.data.tickets.map((t) => String(t.id));
  for (const id of [ticket01.id, ticket02.id, ticket03.id, ticket04.id, ticket06.id]) {
    assert.ok(ids.includes(String(id)), `Admin must see ticket ${id}`);
  }
  assert.equal(
    list.body.data.pagination.total_items,
    list.body.data.tickets.length,
    "limit=100 must return everything in one page",
  );
});

test("status, priority, and category filters work for all roles", async () => {
  const open = await request("/api/v1/tickets?status=OPEN", {
    cookie: customer2Cookie,
  });
  assert.equal(open.status, 200);
  for (const ticket of open.body.data.tickets) {
    assert.equal(ticket.status, "OPEN");
  }

  const urgent = await request("/api/v1/tickets?priority=URGENT", {
    cookie: adminCookie,
  });
  assert.equal(urgent.status, 200);
  for (const ticket of urgent.body.data.tickets) {
    assert.equal(ticket.priority, "URGENT");
  }
  assert.ok(urgent.body.data.tickets.length >= 2, "Expected the two URGENT tickets");

  const category = await request(
    `/api/v1/tickets?category_id=${catActive.id}`,
    { cookie: customer2Cookie },
  );
  assert.equal(category.status, 200);
  for (const ticket of category.body.data.tickets) {
    assert.equal(String(ticket.category_id), String(catActive.id));
  }
});

test("invalid filter values return 400", async () => {
  const res1 = await request("/api/v1/tickets?status=BOGUS", { cookie: adminCookie });
  assert.equal(res1.status, 400);

  const res2 = await request("/api/v1/tickets?priority=LOWCAL", {
    cookie: adminCookie,
  });
  assert.equal(res2.status, 400);

  const res3 = await request("/api/v1/tickets?category_id=abc", {
    cookie: adminCookie,
  });
  assert.equal(res3.status, 400);

  const res4 = await request("/api/v1/tickets?category_id=-1", {
    cookie: adminCookie,
  });
  assert.equal(res4.status, 400);
});

test("assigned_agent_id filter is admin-only (403 for others)", async () => {
  const agentTry = await request(
    `/api/v1/tickets?assigned_agent_id=${agent2Id}`,
    { cookie: agent2Cookie },
  );
  assert.equal(agentTry.status, 403);

  const customerTry = await request(
    `/api/v1/tickets?assigned_agent_id=${agent2Id}`,
    { cookie: customer1Cookie },
  );
  assert.equal(customerTry.status, 403);

  const adminUse = await request(
    `/api/v1/tickets?assigned_agent_id=${agent2Id}&status=OPEN`,
    { cookie: adminCookie },
  );
  assert.equal(adminUse.status, 200);
  for (const ticket of adminUse.body.data.tickets) {
    assert.equal(String(ticket.assigned_agent_id), agent2Id);
    assert.equal(ticket.status, "OPEN");
  }
});

test("sorting is whitelisted and correctly ordered", async () => {
  const invalidSort = await request("/api/v1/tickets?sort=hacked", {
    cookie: adminCookie,
  });
  assert.equal(invalidSort.status, 400);

  const invalidOrder = await request("/api/v1/tickets?order=lateral", {
    cookie: adminCookie,
  });
  assert.equal(invalidOrder.status, 400);

  const desc = await request("/api/v1/tickets?sort=created_at&order=desc&limit=100", {
    cookie: customer1Cookie,
  });
  assert.equal(desc.status, 200);
  const descDates = desc.body.data.tickets.map((t) => t.created_at);
  const descSorted = [...descDates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  assert.deepEqual(descDates, descSorted, "desc must sort newest first");
  // ticket04 was the last ticket created for customer1 — newest first
  assert.equal(String(desc.body.data.tickets[0].id), String(ticket04.id));

  const asc = await request("/api/v1/tickets?sort=created_at&order=asc&limit=100", {
    cookie: customer1Cookie,
  });
  assert.equal(asc.status, 200);
  const ascDates = asc.body.data.tickets.map((t) => t.created_at);
  const ascSorted = [...ascDates].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  assert.deepEqual(ascDates, ascSorted, "asc must sort oldest first");
});

test("pagination slices results and reports totals", async () => {
  const page1 = await request("/api/v1/tickets?limit=2&page=1", {
    cookie: customer1Cookie,
  });
  assert.equal(page1.status, 200);
  const p1Tickets = page1.body.data.tickets;
  assert.ok(p1Tickets.length <= 2);
  assert.equal(page1.body.data.pagination.page, 1);
  assert.equal(page1.body.data.pagination.limit, 2);
  assert.ok(page1.body.data.pagination.total_items >= 3);
  assert.ok(page1.body.data.pagination.total_pages >= 2);

  const page2 = await request("/api/v1/tickets?limit=2&page=2", {
    cookie: customer1Cookie,
  });
  assert.equal(page2.status, 200);
  const p1Ids = p1Tickets.map((t) => String(t.id));
  for (const ticket of page2.body.data.tickets) {
    assert.ok(
      !p1Ids.includes(String(ticket.id)),
      "Pages must not overlap",
    );
  }
  assert.equal(
    page1.body.data.pagination.total_items,
    page2.body.data.pagination.total_items,
  );
});

test("pagination params are validated (400)", async () => {
  const page0 = await request("/api/v1/tickets?page=0", { cookie: adminCookie });
  assert.equal(page0.status, 400);

  const pageStr = await request("/api/v1/tickets?page=later", { cookie: adminCookie });
  assert.equal(pageStr.status, 400);

  const limit0 = await request("/api/v1/tickets?limit=0", { cookie: adminCookie });
  assert.equal(limit0.status, 400);

  const limitBig = await request("/api/v1/tickets?limit=101", { cookie: adminCookie });
  assert.equal(limitBig.status, 400);
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/tickets/:id/history — audit trail access
// ---------------------------------------------------------------------------

test("assigned agent can read the ticket history with all mutations", async () => {
  const { status, body } = await request(
    `/api/v1/tickets/${ticket03.id}/history`,
    { cookie: agent2Cookie },
  );
  assert.equal(status, 200);

  const actions = body.data.history.map((entry) => entry.action);
  assert.ok(actions.includes("TICKET_CREATED"));
  assert.ok(actions.includes("STATUS_CHANGED"));
  assert.ok(actions.filter((a) => a === "STATUS_CHANGED").length >= 4);
  assert.ok(actions.includes("ASSIGNED"), "assignment changes must be audited");
  assert.ok(actions.includes("PRIORITY_CHANGED"));
  for (const entry of body.data.history) {
    assert.ok(entry.created_at);
  }
});

test("history access is scoped: unassigned agent and customer get 403", async () => {
  const unassigned = await request(
    `/api/v1/tickets/${ticket03.id}/history`,
    { cookie: agent1Cookie },
  );
  assert.equal(unassigned.status, 403);

  const customer = await request(
    `/api/v1/tickets/${ticket03.id}/history`,
    { cookie: customer2Cookie },
  );
  assert.equal(customer.status, 403);
});

test("admin reads history of any ticket; missing tickets return 404", async () => {
  const admin = await request(`/api/v1/tickets/${ticket01.id}/history`, {
    cookie: adminCookie,
  });
  assert.equal(admin.status, 200);
  assert.ok(
    admin.body.data.history.some((entry) => entry.action === "TICKET_CREATED"),
  );

  const missing = await request("/api/v1/tickets/99999999/history", {
    cookie: adminCookie,
  });
  assert.equal(missing.status, 404);

  const badId = await request("/api/v1/tickets/abc/history", {
    cookie: adminCookie,
  });
  assert.equal(badId.status, 400);
});

// ---------------------------------------------------------------------------
// Tests: Database errors surface as 500 with the standard envelope
// ---------------------------------------------------------------------------

test("database failures return 500 with consistent error format", async () => {
  const originalQuery = database.query;
  database.query = async (text, ...args) => {
    if (typeof text === "string" && text.includes("FROM tickets t")) {
      throw new Error("Simulated database failure");
    }
    return originalQuery.call(database, text, ...args);
  };

  try {
    const listFailure = await request("/api/v1/tickets", { cookie: adminCookie });
    assert.equal(listFailure.status, 500);
    assert.equal(listFailure.body.status, "error");
    assert.equal(listFailure.body.message, "Internal server error");

    const detailFailure = await request(`/api/v1/tickets/${ticket01.id}`, {
      cookie: adminCookie,
    });
    assert.equal(detailFailure.status, 500);
    assert.equal(detailFailure.body.message, "Internal server error");
  } finally {
    database.query = originalQuery;
  }
});
