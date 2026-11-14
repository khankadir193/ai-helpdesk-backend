/**
 * Integration test suite for the Team module under /api/v1/team
 * Run: node --test src/tests/team.test.js
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";

let server;
let baseUrl;
let adminCookie;
let agentCookie;
// Invitation emails created by this test run (cleaned up in after()).
const createdInvitationEmails = [];

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
  // Revoke invitations created by this run so they don't linger as pending.
  for (const email of createdInvitationEmails) {
    await database.query(
      `UPDATE team_invitations SET status = 'REVOKED', updated_at = now()
       WHERE LOWER(email) = LOWER($1) AND status = 'PENDING'`,
      [email],
    );
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Members list & pagination
// ---------------------------------------------------------------------------

test("GET /team/members returns paginated members with pagination fields", async () => {
  const res = await request("/team/members?page=1&pageSize=5", { cookie: adminCookie });
  assert.equal(res.status, 200);

  const { data } = res.data;
  assert.ok(Array.isArray(data.members));
  assert.ok(data.members.length <= 5);
  assert.ok(Array.isArray(data.invitations));
  assert.equal(typeof data.total, "number");
  assert.equal(data.page, 1);
  assert.equal(data.pageSize, 5);
  assert.ok(data.totalPages >= 1);
  assert.ok(data.meta);
  assert.equal(data.meta.total_members, data.total);
});

test("GET /team/members page 2 returns different rows than page 1", async () => {
  const page1 = await request("/team/members?page=1&pageSize=5", { cookie: adminCookie });
  const page2 = await request("/team/members?page=2&pageSize=5", { cookie: adminCookie });
  assert.equal(page1.status, 200);
  assert.equal(page2.status, 200);

  const ids1 = page1.data.data.members.map((m) => m.id);
  const ids2 = page2.data.data.members.map((m) => m.id);
  assert.equal(ids1.length, 5);
  assert.equal(ids2.length, 5);
  assert.ok(ids1.some((id) => !ids2.includes(id)), "pages 1 and 2 must not overlap");
});

test("GET /team/members supports search (q) with the same response shape", async () => {
  const res = await request("/team/members?pageSize=10&q=zzz_no_such_member_zzz", { cookie: adminCookie });
  assert.equal(res.status, 200);

  const { data } = res.data;
  assert.equal(data.members.length, 0);
  assert.equal(data.total, 0);
  assert.equal(data.totalPages, 1);
  assert.ok(Array.isArray(data.invitations));
});

test("GET /team/members clamps an out-of-range page to the last page", async () => {
  const first = await request("/team/members?page=1&pageSize=5", { cookie: adminCookie });
  const totalPages = first.data.data.totalPages;
  const res = await request("/team/members?page=9999&pageSize=5", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.data.page, totalPages);
  assert.ok(res.data.data.members.length > 0);
});

// Invitations: real email delivery state, resend, revoke
// ---------------------------------------------------------------------------

async function createTestInvitation(prefix) {
  const email = `${prefix}.${Date.now()}@example.com`;
  const res = await request("/team/invitations", {
    method: "POST",
    cookie: adminCookie,
    body: { email, role: "AGENT", team: "General support" },
  });
  createdInvitationEmails.push(email);
  return res;
}

test("POST /team/invitations reports the real email delivery state", async () => {
  const res = await createTestInvitation("delivery.check");
  assert.equal(res.status, 201);

  const invitation = res.data.data.invitation;
  assert.ok(invitation.email_delivery, "email_delivery must be present");
  assert.equal(invitation.email_delivery.sent, true); // console transport in tests
  assert.equal(invitation.email_delivery.mode, "console");
  assert.equal(invitation.token, undefined, "invite token must not leak to the client");
});

test("DELETE /team/invitations/:id revokes, then repeats with a clear 404", async () => {
  const createRes = await createTestInvitation("revoke.flow");
  assert.equal(createRes.status, 201);
  const { id, email } = createRes.data.data.invitation;

  // First revoke succeeds
  const revokeRes = await request(`/team/invitations/${id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(revokeRes.status, 200);
  assert.equal(revokeRes.data.data.revoked, true);

  // Repeating the revoke returns 404 with a clear message
  const repeatRes = await request(`/team/invitations/${id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(repeatRes.status, 404);
  assert.ok(repeatRes.data.message.includes("no longer pending"));

  // The revoked invite is gone from the pending invitations list
  const membersRes = await request("/team/members", { cookie: adminCookie });
  const pendingEmails = membersRes.data.data.invitations.map((inv) => inv.email);
  assert.ok(!pendingEmails.includes(email), "revoked invite must not be listed as pending");
});

test("DELETE /team/invitations/:id rejects non-numeric ids with 404 (not 500)", async () => {
  const res = await request("/team/invitations/not-a-number", { method: "DELETE", cookie: adminCookie });
  assert.equal(res.status, 404);
  assert.ok(res.data.message.includes("not found"));
});

test("DELETE /team/invitations/:id as AGENT returns 403", async () => {
  const createRes = await createTestInvitation("revoke.agent");
  assert.equal(createRes.status, 201);
  const { id } = createRes.data.data.invitation;

  const res = await request(`/team/invitations/${id}`, { method: "DELETE", cookie: agentCookie });
  assert.equal(res.status, 403);
});

test("POST /team/invitations/:id/resend re-sends and extends expiry", async () => {
  const createRes = await createTestInvitation("resend.flow");
  assert.equal(createRes.status, 201);
  const { id, email } = createRes.data.data.invitation;

  const res = await request(`/team/invitations/${id}/resend`, { method: "POST", cookie: adminCookie });
  assert.equal(res.status, 200);

  const invitation = res.data.data.invitation;
  assert.equal(invitation.email, email);
  assert.ok(invitation.email_delivery);
  assert.equal(invitation.email_delivery.sent, true);
  assert.ok(invitation.token === undefined, "invite token must not leak to the client");
  const newExpiry = new Date(invitation.expires_at).getTime();
  assert.ok(newExpiry > Date.now() + 6 * 24 * 60 * 60 * 1000, "expiry must be extended ~7 days");
});

test("POST /team/invitations/:id/resend on an already-revoked invite returns a clear 404", async () => {
  const createRes = await createTestInvitation("resend.revoked");
  assert.equal(createRes.status, 201);
  const { id } = createRes.data.data.invitation;

  await request(`/team/invitations/${id}`, { method: "DELETE", cookie: adminCookie });
  const res = await request(`/team/invitations/${id}/resend`, { method: "POST", cookie: adminCookie });
  assert.equal(res.status, 404);
  assert.ok(res.data.message.includes("no longer pending"));
});

test("GET /team/members lists members and pending invitations (regression)", async () => {
  const res = await request("/team/members", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.data.members));
  assert.ok(Array.isArray(res.data.data.invitations));
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
