/**
 * Integration tests for the full session-based authentication flow:
 *   POST /api/v1/auth/register
 *   POST /api/v1/auth/login
 *   GET  /api/v1/auth/me
 *   POST /api/v1/auth/logout
 *
 * Covers:
 *  - Successful registration (201)
 *  - Duplicate email → 409 (exact, uppercase, mixed-case, concurrent)
 *  - Login with correct credentials → 200 + session cookie
 *  - Login with wrong password → 401
 *  - Login with unknown email → 401
 *  - Session cookie carries authentication across requests
 *  - GET /me returns the current user's safe profile
 *  - GET /me without a session returns 401
 *  - Logout destroys the session → subsequent /me returns 401
 *  - Protected routes reject requests before login, accept after login,
 *    and reject again after logout
 *  - Deactivated accounts are rejected after login
 *  - password_hash never returned in any response
 *  - Session regeneration on login (new session ID each time)
 *  - Role is always loaded from DB, not client-supplied
 *
 * Run: node --test src/tests/auth.test.js
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";
import bcrypt from "bcrypt";

const DUPLICATE_MESSAGE = "Email already exists. Please use a different email.";

let server;
let baseUrl;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

/** POST /api/v1/auth/register */
async function postRegister(payload) {
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

/** POST /api/v1/auth/login — returns status, body, and the raw Set-Cookie header */
async function postLogin(payload) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  const setCookie = res.headers.get("set-cookie") ?? null;
  const cookie = setCookie ? setCookie.split(";")[0] : null;
  return { status: res.status, body, cookie, setCookieHeader: setCookie };
}

/** GET /api/v1/auth/me — pass the raw cookie string */
async function getMe(cookie) {
  const headers = {};
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${baseUrl}/api/v1/auth/me`, { headers });
  const body = await res.json();
  return { status: res.status, body };
}

/** POST /api/v1/auth/logout */
async function postLogout(cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers,
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** A unique email guaranteed not to collide across test runs. */
function uniqueEmail(tag = "") {
  return `test_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
}

// ---------------------------------------------------------------------------
// Registration Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/register", () => {
  test("successful registration returns 201 with safe user object", async () => {
    const email = uniqueEmail("new");
    const { status, body } = await postRegister({
      name: "Alice",
      email,
      password: "SecurePass1!",
    });

    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.status, "success");

    const user = body.data?.user;
    assert.ok(user, "response should include data.user");
    assert.ok(user.id, "user should have an id");
    assert.equal(user.email, email.toLowerCase());
    assert.equal(user.name, "Alice");
    assert.ok(user.role, "user should have a role");
    assert.ok(!user.password_hash, "password_hash must NOT be returned");
    assert.ok(!user.password, "password must NOT be returned");
  });

  test("role is always set by the server, not the client", async () => {
    const { status, body } = await postRegister({
      name: "Attacker",
      email: uniqueEmail("role"),
      password: "SecurePass1!",
      role: "ADMIN", // client attempts to set privileged role
    });

    // Should succeed but role must not be ADMIN
    assert.equal(status, 201);
    const user = body.data?.user;
    assert.ok(user.role !== "ADMIN", `role should not be ADMIN but got: ${user.role}`);
    assert.ok(user.role !== "admin", `role should not be admin but got: ${user.role}`);
  });

  test("duplicate email (exact case) returns 409", async () => {
    const email = uniqueEmail("dup");

    const first = await postRegister({ name: "Bob", email, password: "SecurePass1!" });
    assert.equal(first.status, 201, `first registration failed: ${JSON.stringify(first.body)}`);

    const { status, body } = await postRegister({
      name: "Bob2",
      email,
      password: "AnotherPass1!",
    });

    assert.equal(status, 409);
    assert.equal(body.status, "error");
    assert.equal(body.message, DUPLICATE_MESSAGE);
  });

  test("duplicate email with UPPERCASE casing returns 409", async () => {
    const base = uniqueEmail("upper");
    await postRegister({ name: "Carol", email: base, password: "SecurePass1!" });

    const { status, body } = await postRegister({
      name: "Carol2",
      email: base.toUpperCase(),
      password: "AnotherPass1!",
    });

    assert.equal(status, 409);
    assert.equal(body.message, DUPLICATE_MESSAGE);
  });

  test("duplicate email with mixed casing returns 409", async () => {
    const base = uniqueEmail("mixed");
    await postRegister({ name: "Dave", email: base, password: "SecurePass1!" });

    const mixedEmail = base
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
      .join("");

    const { status, body } = await postRegister({
      name: "Dave2",
      email: mixedEmail,
      password: "AnotherPass1!",
    });

    assert.equal(status, 409);
    assert.equal(body.message, DUPLICATE_MESSAGE);
  });

  test("concurrent duplicate registrations — exactly one succeeds", async () => {
    const email = uniqueEmail("concurrent");
    const payload = { name: "Grace", email, password: "SecurePass1!" };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postRegister(payload)),
    );

    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    assert.equal(successes.length, 1, `exactly one registration should succeed, got ${successes.length}`);
    assert.equal(conflicts.length, 4);

    for (const { body } of conflicts) {
      assert.equal(body.message, DUPLICATE_MESSAGE);
    }
  });

  test("missing name returns 422", async () => {
    const { status, body } = await postRegister({
      email: uniqueEmail("no-name"),
      password: "SecurePass1!",
    });
    assert.equal(status, 422);
    assert.ok(body.errors?.some((e) => e.field === "name"), "should report name error");
  });

  test("whitespace-only name returns 422", async () => {
    const { status, body } = await postRegister({
      name: "   ",
      email: uniqueEmail("ws-name"),
      password: "SecurePass1!",
    });
    assert.equal(status, 422);
    assert.ok(body.errors?.some((e) => e.field === "name"));
  });

  test("invalid email format returns 422", async () => {
    const { status, body } = await postRegister({
      name: "Test",
      email: "not-an-email",
      password: "SecurePass1!",
    });
    assert.equal(status, 422);
    assert.ok(body.errors?.some((e) => e.field === "email"));
  });

  test("password too short (< 8 chars) returns 422", async () => {
    const { status, body } = await postRegister({
      name: "Test",
      email: uniqueEmail("short-pw"),
      password: "abc",
    });
    assert.equal(status, 422);
    assert.ok(body.errors?.some((e) => e.field === "password"));
  });

  test("password too long (> 72 chars) returns 422", async () => {
    const { status, body } = await postRegister({
      name: "Test",
      email: uniqueEmail("long-pw"),
      password: "a".repeat(73),
    });
    assert.equal(status, 422);
    assert.ok(body.errors?.some((e) => e.field === "password"));
  });
});

// ---------------------------------------------------------------------------
// Login Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/login", () => {
  test("successful login returns 200 and a session cookie", async () => {
    const email = uniqueEmail("login-ok");
    await postRegister({ name: "Login User", email, password: "SecurePass1!" });

    const { status, body, cookie, setCookieHeader } = await postLogin({
      email,
      password: "SecurePass1!",
    });

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.status, "success");

    const user = body.data?.user;
    assert.ok(user, "response should include data.user");
    assert.ok(user.id);
    assert.equal(user.email, email.toLowerCase());
    assert.ok(!user.password_hash, "password_hash must NOT be returned on login");

    // A session cookie must be set
    assert.ok(cookie, "a session cookie must be set");
    assert.ok(setCookieHeader?.includes("HttpOnly"), "cookie must be HttpOnly");
    assert.ok(setCookieHeader?.includes("helpdesk.sid"), "cookie must be named helpdesk.sid");
  });

  test("wrong password returns 401 with generic message", async () => {
    const email = uniqueEmail("login-bad-pw");
    await postRegister({ name: "Bad PW", email, password: "SecurePass1!" });

    const { status, body, cookie } = await postLogin({ email, password: "WrongPassword!" });

    assert.equal(status, 401);
    assert.equal(body.status, "error");
    assert.equal(body.message, "Invalid email or password.");
    assert.ok(!cookie, "no cookie should be set on failed login");
  });

  test("non-existent email returns 401 with generic message", async () => {
    const { status, body, cookie } = await postLogin({
      email: uniqueEmail("nosuchuser"),
      password: "SecurePass1!",
    });

    assert.equal(status, 401);
    assert.equal(body.message, "Invalid email or password.");
    assert.ok(!cookie, "no cookie should be set on failed login");
  });

  test("login with deactivated account returns 401", async () => {
    // Create user via direct DB insert to control is_active
    const email = uniqueEmail("deact-login");
    const hash = await bcrypt.hash("SecurePass1!", 12);
    await database.query(
      `INSERT INTO users (name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, $5)`,
      ["Deact User", email, hash, "CUSTOMER", false],
    );

    const { status, body } = await postLogin({ email, password: "SecurePass1!" });
    assert.equal(status, 401);
    assert.ok(body.message.includes("deactivated") || body.message.includes("Invalid"));
  });

  test("login normalizes email (case-insensitive lookup)", async () => {
    const email = uniqueEmail("case-login");
    await postRegister({ name: "Case User", email, password: "SecurePass1!" });

    // Login with uppercase version of the email
    const { status } = await postLogin({
      email: email.toUpperCase(),
      password: "SecurePass1!",
    });
    assert.equal(status, 200, "Login with uppercase email should succeed");
  });

  test("missing email returns 422", async () => {
    const { status } = await postLogin({ password: "SecurePass1!" });
    assert.equal(status, 422);
  });

  test("missing password returns 422", async () => {
    const { status } = await postLogin({ email: "user@example.com" });
    assert.equal(status, 422);
  });
});

// ---------------------------------------------------------------------------
// GET /me Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/auth/me", () => {
  test("returns 401 without a session cookie", async () => {
    const { status, body } = await getMe(null);
    assert.equal(status, 401);
    assert.equal(body.status, "error");
  });

  test("returns 401 with an invalid session cookie", async () => {
    const { status } = await getMe("helpdesk.sid=s%3Ainvalid_garbage.invalid");
    assert.equal(status, 401);
  });

  test("returns 200 with current user's profile after successful login", async () => {
    const email = uniqueEmail("me-ok");
    await postRegister({ name: "Me User", email, password: "SecurePass1!" });
    const { cookie } = await postLogin({ email, password: "SecurePass1!" });

    const { status, body } = await getMe(cookie);
    assert.equal(status, 200);
    assert.equal(body.status, "success");

    const user = body.data?.user;
    assert.ok(user?.id);
    assert.equal(user.email, email.toLowerCase());
    assert.ok(!user.password_hash, "password_hash must NOT be exposed in /me");
    assert.ok(!user.password, "password must NOT be exposed in /me");
  });

  test("session persists across multiple requests", async () => {
    const email = uniqueEmail("session-persist");
    await postRegister({ name: "Persist User", email, password: "SecurePass1!" });
    const { cookie } = await postLogin({ email, password: "SecurePass1!" });

    // Make 3 successive requests with the same cookie
    for (let i = 0; i < 3; i++) {
      const { status } = await getMe(cookie);
      assert.equal(status, 200, `request ${i + 1} should succeed with same cookie`);
    }
  });

  test("session IDs differ between two separate logins (regeneration)", async () => {
    const email = uniqueEmail("regen");
    await postRegister({ name: "Regen User", email, password: "SecurePass1!" });

    const { cookie: cookie1 } = await postLogin({ email, password: "SecurePass1!" });
    const { cookie: cookie2 } = await postLogin({ email, password: "SecurePass1!" });

    assert.notEqual(cookie1, cookie2, "each login should produce a unique session ID");
  });
});

// ---------------------------------------------------------------------------
// Logout Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/logout", () => {
  test("logout returns 200 and /me subsequently returns 401", async () => {
    const email = uniqueEmail("logout-ok");
    await postRegister({ name: "Logout User", email, password: "SecurePass1!" });
    const { cookie } = await postLogin({ email, password: "SecurePass1!" });

    // Verify logged in
    const meBefore = await getMe(cookie);
    assert.equal(meBefore.status, 200);

    // Logout
    const { status: logoutStatus, body: logoutBody } = await postLogout(cookie);
    assert.equal(logoutStatus, 200);
    assert.equal(logoutBody.status, "success");

    // Session must be invalidated
    const meAfter = await getMe(cookie);
    assert.equal(meAfter.status, 401, "old cookie must be rejected after logout");
  });

  test("logout is safe to call without a session (idempotent)", async () => {
    // Call logout with no cookie at all
    const { status } = await postLogout(null);
    assert.equal(status, 200);
  });

  test("protected route is inaccessible after logout", async () => {
    const email = uniqueEmail("protected-after-logout");
    await postRegister({ name: "Guarded", email, password: "SecurePass1!" });
    const { cookie } = await postLogin({ email, password: "SecurePass1!" });

    // Access a protected endpoint while logged in (use /me as the proxy)
    const before = await getMe(cookie);
    assert.equal(before.status, 200);

    await postLogout(cookie);

    // Same cookie must no longer work
    const after = await getMe(cookie);
    assert.equal(after.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Role-Based Authorization via Session
// ---------------------------------------------------------------------------

describe("Role-based authorization (session)", () => {
  test("client-supplied role in body is ignored — server always uses DB role", async () => {
    // Register as normal user (CUSTOMER)
    const email = uniqueEmail("role-spoof");
    await postRegister({ name: "Spoofer", email, password: "SecurePass1!" });
    const { cookie } = await postLogin({ email, password: "SecurePass1!" });

    // Attempt to create a category (requires ADMIN role) with spoofed role header
    const res = await fetch(`${baseUrl}/api/v1/categories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-user-role": "ADMIN",
        Role: "ADMIN",
      },
      body: JSON.stringify({ name: `SpoofCat_${Date.now()}` }),
    });

    // Must be 403 — DB role is CUSTOMER, spoofed header is ignored
    assert.equal(res.status, 403);
  });
});
