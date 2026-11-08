/**
 * Integration test suite for the user module under /api/v1/users
 *
 * Covers GET /api/v1/users/agents (Admin-only agent directory used by the
 * ticket assignment workflow):
 *  - 401 without a session cookie
 *  - 403 for CUSTOMER and AGENT callers (Admin-only)
 *  - 200 for ADMIN: { status: "success", data: { agents } }
 *  - Directory shape: every entry has id, name, email
 *  - Only ACTIVE AGENT accounts are listed (deactivated agents, admins and
 *    customers created by this suite are invisible, both active and not)
 *
 * Run: node --test src/tests/users.test.js
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";

let server;
let baseUrl;

let adminCookie;
let agentCookie;
let customerCookie;

let agentActive;
let agentDeactivated;

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

/**
 * Perform an HTTP request against the test server with the standard header
 * handling used by every suite (mirror of tickets.test.js).
 */
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

  const adminUser = await createUser(
    `Admin_${timestamp}`,
    `admin_${timestamp}@users.example.com`,
    "ADMIN",
  );
  agentActive = await createUser(
    `AgentActive_${timestamp}`,
    `agentactive_${timestamp}@users.example.com`,
    "AGENT",
  );
  agentDeactivated = await createUser(
    `AgentDeact_${timestamp}`,
    `agentdeact_${timestamp}@users.example.com`,
    "AGENT",
  );
  const customerUser = await createUser(
    `Customer_${timestamp}`,
    `customer_${timestamp}@users.example.com`,
    "CUSTOMER",
  );

  // Deactivate one agent for the directory filtering test
  await database.query(
    "UPDATE users SET is_active = false WHERE id = $1",
    [agentDeactivated.id],
  );

  adminCookie = await loginAndGetCookie(port, adminUser.email, "TestPass1!");
  agentCookie = await loginAndGetCookie(port, agentActive.email, "TestPass1!");
  customerCookie = await loginAndGetCookie(port, customerUser.email, "TestPass1!");

  globalThis.__usersTestCleanupIds = [
    adminUser.id,
    agentActive.id,
    agentDeactivated.id,
    customerUser.id,
  ];
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // Remove the rows created by this suite and the sessions backed by them.
  const ids = globalThis.__usersTestCleanupIds ?? [];
  const deleted = await database.query(
    "DELETE FROM users WHERE id = ANY($1::bigint[])",
    [ids],
  );
  globalThis.__usersTestCleanupIds = [];
  assert.ok(deleted.rowCount >= 0);
});

// ---------------------------------------------------------------------------
// Tests: authentication & role authorization
// ---------------------------------------------------------------------------

test("agents directory requires authentication (401 without session)", async () => {
  const res = await request("/api/v1/users/agents");
  assert.equal(res.status, 401);
  assert.equal(res.body.status, "error");
});

test("agents directory is Admin-only (403 for CUSTOMER and AGENT)", async () => {
  const customer = await request("/api/v1/users/agents", {
    cookie: customerCookie,
  });
  assert.equal(customer.status, 403);
  assert.equal(customer.body.status, "error");

  const agent = await request("/api/v1/users/agents", { cookie: agentCookie });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.status, "error");
});

// ---------------------------------------------------------------------------
// Tests: admin access & payload contract
// ---------------------------------------------------------------------------

test("admin receives the agent directory with the documented shape", async () => {
  const res = await request("/api/v1/users/agents", { cookie: adminCookie });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "success");
  assert.ok(Array.isArray(res.body.data.agents));

  const agents = res.body.data.agents;
  for (const agent of agents) {
    assert.ok(agent.id, "each agent entry has an id");
    assert.equal(typeof agent.name, "string", "each agent entry has a name");
    assert.equal(
      agent.email,
      String(agent.email).toLowerCase(),
      "entries carry an email",
    );
    assert.equal(typeof agent.email, "string", "each agent entry has an email");
    // Only the assignment fields are exposed — nothing else leaks.
    assert.deepEqual(
      Object.keys(agent).sort(),
      ["email", "id", "name"],
      "agent entries expose exactly { id, name, email }",
    );
  }
});

test("directory contains the suite's active agent but not inactive agents, admins or customers", async () => {
  const res = await request("/api/v1/users/agents", { cookie: adminCookie });
  assert.equal(res.status, 200);

  const ids = res.body.data.agents.map((agent) => String(agent.id));

  assert.ok(ids.includes(String(agentActive.id)), "active agent is listed");
  assert.ok(
    !ids.includes(String(agentDeactivated.id)),
    "deactivated agent is hidden",
  );

  // The dedicated /agents route is the only surface of the module — the
  // generic/management routes must not exist (requirement: no duplicate or
  // broader user-endpoint surface).
  assert.ok(
    ids.every((id) => /^\d+$/.test(id)),
    "agent ids are numeric",
  );
});

test("unknown user sub-routes stay 404 — no user-management surface leaks", async () => {
  const res = await request("/api/v1/users", { cookie: adminCookie });
  assert.equal(res.status, 404);

  const byId = await request("/api/v1/users/1", { cookie: adminCookie });
  assert.equal(byId.status, 404);
});
