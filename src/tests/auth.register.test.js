/**
 * Integration tests for POST /api/v1/auth/register
 *
 * Covers:
 *  - Successful registration (201)
 *  - Exact-case duplicate email → 409 with required message
 *  - Case-insensitive duplicate email (UPPER, Mixed) → 409
 *  - No user record inserted on duplicate attempt
 *  - Concurrent duplicate registrations handled gracefully
 *
 * Run: node --test src/tests/auth.register.test.js
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";

const DUPLICATE_MESSAGE =
  "Email already exists. Please use a different email.";

let server;
let baseUrl;

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

/** POST /api/v1/auth/register with the given payload. */
async function postRegister(payload) {
  const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body };
}

/** A unique email guaranteed not to collide across test runs. */
function uniqueEmail(tag = "") {
  return `test_${tag}_${Date.now()}@example.com`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("successful registration returns 201 with user object", async () => {
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
  assert.equal(user.email, email.toLowerCase());
  assert.ok(user.id, "user should have an id");
  assert.ok(!user.password_hash, "password_hash must not be returned");
});

test("duplicate email (exact case) returns 409 with required message", async () => {
  const email = uniqueEmail("dup");

  // First registration — must succeed
  const first = await postRegister({ name: "Bob", email, password: "SecurePass1!" });
  assert.equal(first.status, 201, `first registration failed: ${JSON.stringify(first.body)}`);

  // Second registration — must conflict
  const { status, body } = await postRegister({
    name: "Bob2",
    email,
    password: "AnotherPass1!",
  });

  assert.equal(status, 409, `expected 409, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, "error");
  assert.equal(
    body.message,
    DUPLICATE_MESSAGE,
    `wrong conflict message: "${body.message}"`,
  );
});

test("duplicate email with UPPERCASE casing returns 409", async () => {
  const base = uniqueEmail("upper");

  await postRegister({ name: "Carol", email: base, password: "SecurePass1!" });

  const { status, body } = await postRegister({
    name: "Carol2",
    email: base.toUpperCase(),
    password: "AnotherPass1!",
  });

  assert.equal(status, 409, `expected 409 for uppercase duplicate, got ${status}`);
  assert.equal(body.message, DUPLICATE_MESSAGE);
});

test("duplicate email with mixed casing returns 409", async () => {
  const base = uniqueEmail("mixed");

  await postRegister({ name: "Dave", email: base, password: "SecurePass1!" });

  // Toggle case of every other character
  const mixedEmail = base
    .split("")
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join("");

  const { status, body } = await postRegister({
    name: "Dave2",
    email: mixedEmail,
    password: "AnotherPass1!",
  });

  assert.equal(status, 409, `expected 409 for mixed-case duplicate, got ${status}`);
  assert.equal(body.message, DUPLICATE_MESSAGE);
});

test("duplicate attempt does not create a new user record", async () => {
  const email = uniqueEmail("noinsert");

  // First registration
  const first = await postRegister({ name: "Eve", email, password: "SecurePass1!" });
  assert.equal(first.status, 201);
  const originalId = first.body.data.user.id;

  // Duplicate attempt
  await postRegister({ name: "Eve2", email, password: "AnotherPass1!" });

  // A fresh registration with a new email must still succeed and return a new id
  const newEmail = uniqueEmail("noinsert_next");
  const next = await postRegister({ name: "Frank", email: newEmail, password: "SecurePass1!" });
  assert.equal(next.status, 201, `fresh registration after duplicate failed: ${JSON.stringify(next.body)}`);

  const newId = next.body.data.user.id;
  assert.notEqual(newId, originalId, "new user should have a different id");
});

test("concurrent duplicate registrations — at most one succeeds, others return 409", async () => {
  const email = uniqueEmail("concurrent");
  const payload = { name: "Grace", email, password: "SecurePass1!" };

  // Fire 5 identical requests simultaneously
  const results = await Promise.all(
    Array.from({ length: 5 }, () => postRegister(payload)),
  );

  const successes = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);

  assert.equal(successes.length, 1, `exactly one registration should succeed, got ${successes.length}`);
  assert.equal(conflicts.length, 4, `four duplicates should conflict, got ${conflicts.length}`);

  for (const { body } of conflicts) {
    assert.equal(body.message, DUPLICATE_MESSAGE);
  }
});
