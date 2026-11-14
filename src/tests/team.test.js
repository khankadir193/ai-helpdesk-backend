/**
 * Integration test suite for the Team module under /api/v1/team
 * Run: node --test src/tests/team.test.js
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";

let server;
let baseUrl;
let adminCookie;
let agentCookie;

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
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  let json = null;
  let text = null;
  if (contentType.includes("application/json")) {
    json = await res.json();
  } else {
    text = await res.text();
  }

  return { status: res.status, headers: res.headers, data: json, text };
}

before(async () => {
  server = app.listen(0);
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  // Fetch admin and agent session cookies
  adminCookie = await loginAndGetCookie(port, "admin@example.com", "khanAdmin@543");
  agentCookie = await loginAndGetCookie(port, "agent@example.com", "khanAgent@543");
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("GET /team/performance requires authentication (401)", async () => {
  const res = await request("/team/performance");
  assert.equal(res.status, 401);
});

test("GET /team/performance returns KPIs, throughput, workload, agents, and meta", async () => {
  const res = await request("/team/performance", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "success");

  const { data } = res.data;
  assert.ok(data.kpis);
  assert.ok(data.kpis.resolved_tickets != null);
  assert.ok(data.kpis.sla_compliance_pct != null);

  assert.ok(Array.isArray(data.throughput));
  assert.ok(data.workload);
  assert.ok(data.workload.open_tickets != null);
  assert.ok(data.workload.unassigned != null);
  assert.ok(data.workload.in_progress != null);

  assert.ok(Array.isArray(data.agents));
  assert.ok(data.meta);
  assert.ok(data.meta.footnote);
});

test("GET /team/performance/export returns CSV file", async () => {
  const res = await request("/team/performance/export", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/csv"));
  assert.ok(res.text.includes("\"Agent\""));
  assert.ok(res.text.includes("\"Open now\""));
});

test("GET /team/roles returns matrix and permissions", async () => {
  const res = await request("/team/roles", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "success");

  const { data } = res.data;
  assert.equal(data.can_edit, true);
  assert.ok(data.admin_contact);
  assert.ok(Array.isArray(data.roles));
  assert.ok(Array.isArray(data.permissions));
  assert.equal(data.permissions.length, 9);
});

test("PATCH /team/roles blocks non-admins (403)", async () => {
  const res = await request("/team/roles", {
    method: "PATCH",
    cookie: agentCookie,
    body: { permissions: [] },
  });
  assert.equal(res.status, 403);
});

test("PATCH /team/roles enforces critical Admin protections (422)", async () => {
  const res = await request("/team/roles", {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      permissions: [
        {
          id: "billing_security_settings",
          admin_value: "Not allowed",
          manager_value: "Not allowed",
          agent_value: "Not allowed",
        },
      ],
    },
  });
  assert.equal(res.status, 422);
  assert.ok(res.data.message.includes("Cannot revoke 'Billing, security & settings'"));
});

test("POST /team/roles/request-change validates input and records request", async () => {
  const badRes = await request("/team/roles/request-change", {
    method: "POST",
    cookie: agentCookie,
    body: { reason: "hi" }, // too short
  });
  assert.equal(badRes.status, 400);

  const okRes = await request("/team/roles/request-change", {
    method: "POST",
    cookie: agentCookie,
    body: { reason: "Need billing permissions to update card." },
  });
  assert.equal(okRes.status, 200);
  assert.ok(okRes.data.data?.message || okRes.data.message);
});

test("GET /team/teams returns available teams", async () => {
  const res = await request("/team/teams", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.data.teams));
  assert.ok(res.data.data.teams.length > 0);
});

test("GET /team/invite-options returns role options", async () => {
  const res = await request("/team/invite-options", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.data.assignable_roles, ["AGENT", "MANAGER", "ADMIN"]);
});

test("POST /team/invitations validates email and rejects duplicates", async () => {
  // Bad email
  const badEmailRes = await request("/team/invitations", {
    method: "POST",
    cookie: adminCookie,
    body: { email: "not-an-email", role: "AGENT", team: "General support" },
  });
  assert.equal(badEmailRes.status, 400);

  // Existing user duplicate
  const dupUserRes = await request("/team/invitations", {
    method: "POST",
    cookie: adminCookie,
    body: { email: "admin@example.com", role: "AGENT", team: "General support" },
  });
  assert.equal(dupUserRes.status, 409);

  // Create valid invitation
  const testEmail = `new.teammate.${Date.now()}@example.com`;
  const inviteRes = await request("/team/invitations", {
    method: "POST",
    cookie: adminCookie,
    body: { email: testEmail, role: "AGENT", team: "General support" },
  });
  assert.equal(inviteRes.status, 201);
  assert.equal(inviteRes.data.data.invitation.email, testEmail);

  // Duplicate active invitation
  const dupInviteRes = await request("/team/invitations", {
    method: "POST",
    cookie: adminCookie,
    body: { email: testEmail, role: "AGENT", team: "General support" },
  });
  assert.equal(dupInviteRes.status, 409);
});

test("GET /team/members lists active members and pending invitations", async () => {
  const res = await request("/team/members", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.data.members));
  assert.ok(Array.isArray(res.data.data.invitations));
  assert.ok(res.data.data.members.length > 0);
});
