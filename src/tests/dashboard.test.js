/**
 * Integration test suite for the role-based dashboard API
 * under GET /api/v1/dashboard
 *
 * Tests share a persistent database with the other suites, so the admin
 * assertions are expressed as deltas against whole-table baseline
 * aggregates captured before fixture creation; the agent/customer
 * assertions are exact because their fixtures use freshly created users
 * that cannot have pre-existing tickets.
 *
 * Covers:
 *  - Authentication (401)
 *  - Admin dashboard: totals, status counts, priority counts, category
 *    counts (incl. uncategorized) and agent workload (incl. zero workload)
 *  - Agent dashboard: exact counts over assigned tickets only
 *  - Customer dashboard: exact counts over owned tickets only,
 *    data isolation between customers
 *  - Agent assignment isolation between agents
 *  - Empty dashboard (a customer without tickets)
 *  - Recent-ticket pagination and invalid query parameters (400)
 *  - Dashboard aggregates are read-only (no ticket fields change)
 *  - Database failure -> 500 with the generic error envelope
 *
 * Run: node --test src/tests/dashboard.test.js
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
let agent3User;
let customer1User;
let customer2User;
let customer3User;

// Session cookies
let adminCookie;
let agent1Cookie;
let agent2Cookie;
let customer1Cookie;
let customer2Cookie;
let customer3Cookie;

// Categories and tickets
let catBilling;
let catNetwork;
let tickets; // t1..t7 and derived/status changed tickets indexed by name
let baseline; // whole-table aggregates captured before fixtures

let catBillingBaseCount;
let catNetworkBaseCount;
let uncategorizedBaseCount;

const PRIORITY_KEYS = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const STATUS_KEYS = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

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

  // Baseline whole-table aggregates for the delta-based admin assertions.
  const { rows: statusBase } = await database.query(
    "SELECT status, COUNT(*)::int AS count FROM tickets GROUP BY status",
  );
  const { rows: priorityBase } = await database.query(
    "SELECT priority, COUNT(*)::int AS count FROM tickets GROUP BY priority",
  );
  const { rows: categoryBase } = await database.query(
    "SELECT category_id, COUNT(*)::int AS count FROM tickets GROUP BY category_id",
  );
  baseline = {
    status: Object.fromEntries(STATUS_KEYS.map((k) => [k, 0])),
    priority: Object.fromEntries(PRIORITY_KEYS.map((k) => [k, 0])),
  };
  for (const row of statusBase) baseline.status[row.status] = row.count;
  for (const row of priorityBase) baseline.priority[row.priority] = row.count;
  const categoryCounts = new Map(
    categoryBase.map((row) => [row.category_id, row.count]),
  );
  uncategorizedBaseCount = categoryCounts.get(null) ?? 0;

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
    `admin_${timestamp}@dashboard.example.com`,
    "ADMIN",
  );
  agent1User = await createUser(
    `Agent1_${timestamp}`,
    `agent1_${timestamp}@dashboard.example.com`,
    "AGENT",
  );
  agent2User = await createUser(
    `Agent2_${timestamp}`,
    `agent2_${timestamp}@dashboard.example.com`,
    "AGENT",
  );
  agent3User = await createUser(
    `Agent3_${timestamp}`,
    `agent3_${timestamp}@dashboard.example.com`,
    "AGENT",
  );
  customer1User = await createUser(
    `Customer1_${timestamp}`,
    `customer1_${timestamp}@dashboard.example.com`,
    "CUSTOMER",
  );
  customer2User = await createUser(
    `Customer2_${timestamp}`,
    `customer2_${timestamp}@dashboard.example.com`,
    "CUSTOMER",
  );
  customer3User = await createUser(
    `Customer3_${timestamp}`,
    `customer3_${timestamp}@dashboard.example.com`,
    "CUSTOMER",
  );

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
  customer3Cookie = await loginAndGetCookie(
    port,
    customer3User.email,
    "TestPass1!",
  );

  const category = (
    await request("/api/v1/categories", {
      method: "POST",
      cookie: adminCookie,
      body: { name: `Billing_${timestamp}` },
    })
  ).body.data.category;
  catBilling = category;
  const { rows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM tickets WHERE category_id = $1",
    [catBilling.id],
  );
  catBillingBaseCount = rows[0].n;

  catNetwork = (
    await request("/api/v1/categories", {
      method: "POST",
      cookie: adminCookie,
      body: { name: `Network_${timestamp}` },
    })
  ).body.data.category;
  const { rows: networkRows } = await database.query(
    "SELECT COUNT(*)::int AS n FROM tickets WHERE category_id = $1",
    [catNetwork.id],
  );
  catNetworkBaseCount = networkRows[0].n;

  await createFixtures();
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
 * Create the fixture tickets through the public API (POST /tickets, PATCH
 * /assignment, PATCH /status) so the dashboard aggregates are exercised
 * against real workflow data.
 */
async function createFixtures() {
  async function create(cookie, { title, priority, categoryId }) {
    const { status, body } = await request("/api/v1/tickets", {
      method: "POST",
      cookie,
      body: {
        title,
        description: `${title} - dashboard fixture`,
        category_id: categoryId,
        priority,
      },
    });
    assert.equal(status, 201, `fixture ticket creation failed: ${title}`);
    return body.data.ticket;
  }

  tickets = {};

  // t1..t6 are created by customer1 (t7 belongs to customer2).
  tickets.t1 = await create(customer1Cookie, {
    title: "t1 login loop",
    priority: "MEDIUM",
    categoryId: catBilling.id,
  });
  tickets.t2 = await create(customer1Cookie, {
    title: "t2 cannot connect",
    priority: "HIGH",
    categoryId: catNetwork.id,
  });

  // Assignment/ownership fixtures are structured before the status changes
  // below so rules (who may patch what) stay honest.
  for (const ticket of [tickets.t1, tickets.t2]) {
    const assignment = await request(
      `/api/v1/tickets/${ticket.id}/assignment`,
      {
        method: "PATCH",
        cookie: adminCookie,
        body: { assigned_agent_id: agent1User.id },
      },
    );
    assert.equal(
      assignment.status,
      200,
      "fixture assignment failed",
    );
  }
  tickets.t3 = await create(customer1Cookie, {
    title: "t3 stuck progress",
    priority: "URGENT",
    categoryId: catBilling.id,
  });
  tickets.t4 = await create(customer1Cookie, {
    title: "t4 export fails",
    priority: "LOW",
    categoryId: catBilling.id,
  });
  tickets.t5 = await create(customer1Cookie, {
    title: "t5 wifi drops",
    priority: "LOW",
    categoryId: catNetwork.id,
  });

  const assign = (ticket, agent) =>
    request(`/api/v1/tickets/${ticket.id}/assignment`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { assigned_agent_id: agent.id },
    });
  for (const ticket of [tickets.t3, tickets.t4]) {
    const { status } = await assign(ticket, agent1User);
    assert.equal(status, 200, "fixture assignment failed");
  }
  tickets.t6 = await create(customer1Cookie, {
    title: "t6 old issue",
    priority: "HIGH",
    categoryId: catBilling.id,
  });
  tickets.t7 = await create(customer2Cookie, {
    title: "t7 refund query",
    priority: "MEDIUM",
    categoryId: catBilling.id,
  });
  for (const ticket of [tickets.t6, tickets.t7]) {
    const { status } = await assign(ticket, agent2User);
    assert.equal(status, 200, "fixture assignment failed");
  }

  // Status walk: t3 -> IN_PROGRESS, t4 -> RESOLVED, t6 -> CLOSED.
  const patchStatus = (ticket, cookie, status) =>
    request(`/api/v1/tickets/${ticket.id}/status`, {
      method: "PATCH",
      cookie,
      body: { status },
    });
  let { status: s3 } = await patchStatus(tickets.t3, agent1Cookie, "IN_PROGRESS");
  assert.equal(s3, 200, "fixture status change failed");
  const { status: s4 } = await patchStatus(tickets.t4, agent1Cookie, "RESOLVED");
  assert.equal(s4, 200, "fixture status change failed");
  const { status: s6 } = await patchStatus(tickets.t6, agent2Cookie, "CLOSED");
  assert.equal(s6, 200, "fixture status change failed");
}

function assertListShape(ticket) {
  assert.ok(ticket.id);
  assert.ok(ticket.title);
  assert.ok(ticket.status);
  assert.ok(ticket.priority);
  assert.ok(ticket.created_at);
}

// ---------------------------------------------------------------------------
// Tests: Authentication
// ---------------------------------------------------------------------------

test("dashboard requires authentication (401 without a session)", async () => {
  const { status, body } = await request("/api/v1/dashboard");
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

// ---------------------------------------------------------------------------
// Tests: Admin dashboard
// ---------------------------------------------------------------------------

test("admin dashboard aggregates the whole table (status/priority)", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: adminCookie,
  });
  assert.equal(status, 200);
  assert.equal(body.status, "success");

  const dashboard = body.data.dashboard;
  assert.equal(dashboard.role, "ADMIN");

  const expectedStatus = {
    ...baseline.status,
    OPEN: baseline.status.OPEN + 4, // t1, t2, t5, t7
    IN_PROGRESS: baseline.status.IN_PROGRESS + 1, // t3
    RESOLVED: baseline.status.RESOLVED + 1, // t4
    CLOSED: baseline.status.CLOSED + 1, // t6
  };
  assert.deepEqual(dashboard.status_counts, expectedStatus);

  const expectedPriority = {
    ...baseline.priority,
    LOW: baseline.priority.LOW + 2, // t4, t5
    MEDIUM: baseline.priority.MEDIUM + 2, // t1, t7
    HIGH: baseline.priority.HIGH + 2, // t2, t6
    URGENT: baseline.priority.URGENT + 1, // t3
  };
  assert.deepEqual(dashboard.priority_counts, expectedPriority);

  const statusSum = STATUS_KEYS.reduce((s, k) => s + expectedStatus[k], 0);
  const prioritySum = PRIORITY_KEYS.reduce((s, k) => s + expectedPriority[k], 0);
  assert.equal(dashboard.total_tickets, statusSum);
  assert.equal(statusSum, prioritySum);
});

test("admin dashboard includes category counts with uncategorized grouping", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: adminCookie,
  });
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;

  const billing = dashboard.category_counts.find(
    (entry) => entry.category_id === String(catBilling.id),
  );
  assert.ok(billing, "the Billing fixture category must appear");
  assert.equal(billing.category_name, catBilling.name);
  assert.equal(billing.count, catBillingBaseCount + 5); // t1, t3, t4, t6, t7

  const network = dashboard.category_counts.find(
    (entry) => entry.category_id === String(catNetwork.id),
  );
  assert.ok(network, "the Network fixture category must appear");
  assert.equal(network.count, catNetworkBaseCount + 2); // t2, t5

  const uncategorized = dashboard.category_counts.find(
    (entry) => entry.category_id === null,
  );
  if (uncategorizedBaseCount > 0 || uncategorized) {
    assert.equal(uncategorized?.count, uncategorizedBaseCount);
  }

  // Sorted by count descending.
  for (let i = 1; i < dashboard.category_counts.length; i++) {
    assert.ok(
      dashboard.category_counts[i - 1].count >= dashboard.category_counts[i].count,
      "category counts must be ordered by count descending",
    );
  }
});

test("admin dashboard includes agent workload including zero-count agents", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: adminCookie,
  });
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;

  const workloadFor = (agentId) =>
    dashboard.agent_workload.find((entry) => entry.agent_id === String(agentId));

  const agent1 = workloadFor(agent1User.id);
  assert.ok(agent1, "agent1 must appear in the workload");
  assert.deepEqual(agent1, {
    agent_id: String(agent1User.id),
    agent_name: agent1User.name,
    total_assigned: 4,
    open: 2, // t1, t2
    in_progress: 1, // t3
    resolved: 1, // t4
    closed: 0,
  });

  const agent2 = workloadFor(agent2User.id);
  assert.deepEqual(agent2, {
    agent_id: String(agent2User.id),
    agent_name: agent2User.name,
    total_assigned: 2,
    open: 1, // t7
    in_progress: 0,
    resolved: 0,
    closed: 1, // t6
  });

  const agent3 = workloadFor(agent3User.id);
  assert.ok(agent3, "an agent with zero tickets must still be listed");
  assert.deepEqual(agent3, {
    agent_id: String(agent3User.id),
    agent_name: agent3User.name,
    total_assigned: 0,
    open: 0,
    in_progress: 0,
    resolved: 0,
    closed: 0,
  });

  for (const entry of dashboard.agent_workload) {
    assert.equal(
      entry.open + entry.in_progress + entry.resolved + entry.closed,
      entry.total_assigned,
      "workload status counts must sum to the agent total",
    );
  }
  for (let i = 1; i < dashboard.agent_workload.length; i++) {
    assert.ok(
      dashboard.agent_workload[i - 1].total_assigned >=
        dashboard.agent_workload[i].total_assigned,
      "workload must be ordered by total_assigned descending",
    );
  }
});

test("admin dashboard recent tickets are the newest tickets, paginated", async () => {
  const { status, body } = await request(
    "/api/v1/dashboard?page=1&limit=10",
    { cookie: adminCookie },
  );
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;

  const first = dashboard.recent_tickets.slice(0, 7);
  assert.deepEqual(
    first.map((ticket) => String(ticket.id)),
    [
      tickets.t7.id,
      tickets.t6.id,
      tickets.t5.id,
      tickets.t4.id,
      tickets.t3.id,
      tickets.t2.id,
      tickets.t1.id,
    ],
    "the freshly created fixtures must be the newest tickets in order",
  );
  for (const ticket of first) {
    assertListShape(ticket);
  }
  assert.ok(dashboard.pagination.total_items >= 7);
  assert.equal(dashboard.pagination.page, 1);
  assert.equal(dashboard.pagination.limit, 10);
});

// ---------------------------------------------------------------------------
// Tests: Agent dashboard (assignment isolation)
// ---------------------------------------------------------------------------

test("agent dashboard covers exactly the assigned tickets in all statuses", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: agent1Cookie,
  });
  assert.equal(status, 200);
  assert.equal(body.status, "success");

  const dashboard = body.data.dashboard;
  assert.equal(dashboard.role, "AGENT");
  assert.equal(dashboard.total_tickets, 4);
  assert.deepEqual(dashboard.status_counts, {
    OPEN: 2, // t1, t2
    IN_PROGRESS: 1, // t3
    RESOLVED: 1, // t4
    CLOSED: 0,
  });
  assert.deepEqual(dashboard.priority_counts, {
    LOW: 1, // t4
    MEDIUM: 1, // t1
    HIGH: 1, // t2
    URGENT: 1, // t3
  });
  assert.deepEqual(
    dashboard.recent_tickets.map((ticket) => String(ticket.id)).slice(0, 4),
    [tickets.t4.id, tickets.t3.id, tickets.t2.id, tickets.t1.id],
  );
  assert.deepEqual(dashboard.pagination, {
    page: 1,
    limit: 20,
    total_items: 4,
    total_pages: 1,
  });

  // Admin-only sections must not leak into agent dashboards.
  assert.equal(dashboard.category_counts, undefined);
  assert.equal(dashboard.agent_workload, undefined);
});

test("agent dashboards are isolated between agents", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: agent2Cookie,
  });
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;
  assert.equal(dashboard.total_tickets, 2);
  assert.deepEqual(dashboard.status_counts, {
    OPEN: 1, // t7
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 1, // t6
  });
  assert.deepEqual(dashboard.priority_counts, {
    LOW: 0,
    MEDIUM: 1, // t7
    HIGH: 1, // t6
    URGENT: 0,
  });
  assert.deepEqual(
    dashboard.recent_tickets.map((ticket) => String(ticket.id)),
    [tickets.t7.id, tickets.t6.id],
  );
});

// ---------------------------------------------------------------------------
// Tests: Customer dashboard (data isolation, empty dashboard)
// ---------------------------------------------------------------------------

test("customer dashboard covers exactly their own tickets", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: customer1Cookie,
  });
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;
  assert.equal(dashboard.role, "CUSTOMER");
  assert.equal(dashboard.total_tickets, 6);
  assert.deepEqual(dashboard.status_counts, {
    OPEN: 3, // t1, t2, t5
    IN_PROGRESS: 1, // t3
    RESOLVED: 1, // t4
    CLOSED: 1, // t6
  });
  assert.deepEqual(dashboard.priority_counts, {
    LOW: 2, // t4, t5
    MEDIUM: 1, // t1
    HIGH: 2, // t2, t6
    URGENT: 1, // t3
  });
  assert.deepEqual(
    dashboard.recent_tickets.map((ticket) => String(ticket.id)).slice(0, 6),
    [
      tickets.t6.id,
      tickets.t5.id,
      tickets.t4.id,
      tickets.t3.id,
      tickets.t2.id,
      tickets.t1.id,
    ],
  );
  assert.equal(dashboard.category_counts, undefined);
  assert.equal(dashboard.agent_workload, undefined);
});

test("customers cannot see other customers' ticket statistics", async () => {
  const { status, body } = await request("/api/v1/dashboard", {
    cookie: customer2Cookie,
  });
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;
  assert.equal(dashboard.total_tickets, 1); // only t7
  assert.deepEqual(dashboard.status_counts, {
    OPEN: 1,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 0,
  });
  assert.equal(
    dashboard.recent_tickets.find(
      (ticket) =>
        ![
          tickets.t7.id,
        ].includes(String(ticket.id)),
    ),
    undefined,
    "no other customer's ticket may appear",
  );
});

test("dashboard of a customer without tickets is empty but well-formed", async () => {
  const { status, body } = await request(
    "/api/v1/dashboard?page=1&limit=5",
    { cookie: customer3Cookie },
  );
  assert.equal(status, 200);
  const dashboard = body.data.dashboard;
  assert.equal(dashboard.role, "CUSTOMER");
  assert.equal(dashboard.total_tickets, 0);
  assert.deepEqual(dashboard.status_counts, {
    OPEN: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 0,
  });
  assert.deepEqual(dashboard.priority_counts, {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    URGENT: 0,
  });
  assert.deepEqual(dashboard.recent_tickets, []);
  assert.deepEqual(dashboard.pagination, {
    page: 1,
    limit: 5,
    total_items: 0,
    total_pages: 0,
  });
});

// ---------------------------------------------------------------------------
// Tests: Pagination and invalid query parameters
// ---------------------------------------------------------------------------

test("recent-ticket pagination slices the scoped set", async () => {
  let { status, body } = await request(
    "/api/v1/dashboard?page=1&limit=2",
    { cookie: agent1Cookie },
  );
  assert.equal(status, 200);
  assert.deepEqual(
    body.data.dashboard.recent_tickets.map((ticket) => String(ticket.id)),
    [tickets.t4.id, tickets.t3.id],
  );
  assert.deepEqual(body.data.dashboard.pagination, {
    page: 1,
    limit: 2,
    total_items: 4,
    total_pages: 2,
  });

  ({ status, body } = await request(
    "/api/v1/dashboard?page=2&limit=2",
    { cookie: agent1Cookie },
  ));
  assert.equal(status, 200);
  assert.deepEqual(
    body.data.dashboard.recent_tickets.map((ticket) => String(ticket.id)),
    [tickets.t2.id, tickets.t1.id],
  );

  // A page past the end is empty but keeps the correct totals.
  ({ status, body } = await request(
    "/api/v1/dashboard?page=3&limit=2",
    { cookie: agent1Cookie },
  ));
  assert.equal(status, 200);
  assert.deepEqual(body.data.dashboard.recent_tickets, []);
  assert.equal(body.data.dashboard.pagination.total_items, 4);
});

test("invalid pagination parameters return 400", async () => {
  for (const query of [
    "page=0",
    "page=-1",
    "page=abc",
    "page=1.5",
    "limit=0",
    "limit=101",
    "limit=abc",
  ]) {
    const { status, body } = await request(`/api/v1/dashboard?${query}`, {
      cookie: adminCookie,
    });
    assert.equal(status, 400, `Expected 400 for "?${query}"`);
    assert.equal(body.status, "error");
  }
});

// ---------------------------------------------------------------------------
// Tests: Read-only behaviour
// ---------------------------------------------------------------------------

test("dashboard reads never modify tickets", async () => {
  const detailBefore = (
    await request(`/api/v1/tickets/${tickets.t1.id}`, {
      cookie: agent1Cookie,
    })
  ).body.data.ticket;

  await request("/api/v1/dashboard", { cookie: adminCookie });
  await request("/api/v1/dashboard", { cookie: agent1Cookie });
  await request("/api/v1/dashboard", { cookie: customer1Cookie });

  const detailAfter = (
    await request(`/api/v1/tickets/${tickets.t1.id}`, {
      cookie: agent1Cookie,
    })
  ).body.data.ticket;

  assert.deepEqual(detailAfter, detailBefore);
});

// ---------------------------------------------------------------------------
// Tests: Database failures
// ---------------------------------------------------------------------------

test("database failure returns 500 with the generic envelope", async () => {
  const originalQuery = database.query;
  database.query = async (text, ...args) => {
    if (/COUNT\(/.test(String(text))) {
      throw new Error("Simulated dashboard aggregate failure");
    }
    return originalQuery.call(database, text, ...args);
  };

  try {
    const res = await request("/api/v1/dashboard", { cookie: adminCookie });
    assert.equal(res.status, 500);
    assert.equal(res.body.status, "error");
    assert.equal(res.body.message, "Internal server error");
  } finally {
    database.query = originalQuery;
  }
});
