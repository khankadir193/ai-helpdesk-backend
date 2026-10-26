/**
 * Integration test suite for Categories feature under /api/v1/categories
 *
 * Covers:
 *  - Authentication & Role-based Authorization (Customers, Agents, Admins)
 *  - Client role-spoofing prevention (never trust client-supplied role)
 *  - GET / (role-dependent visibility, active-only for customers/agents, all for admins)
 *  - GET /:id (valid, inactive hidden for customer/agent, visible for admin, missing 404, invalid ID 400)
 *  - POST / (create category, validation, whitespace check, max lengths, unknown fields, defaults)
 *  - Case-insensitive duplicate name conflict (exact case, uppercase, mixed, concurrent)
 *  - PATCH /:id (update name, description, active status, duplicate name checks, updated_at update)
 *  - PATCH /:id/status (activate/deactivate)
 *  - Inactive categories referenced by existing tickets (ticket history preserved, new tickets blocked)
 *  - Error responses (400, 401, 403, 404, 409, 422, 500)
 *
 * Run: node --test src/tests/categories.test.js
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../app.js";
import database from "../config/database.js";
import ticketService from "../modules/tickets/ticket.service.js";

let server;
let baseUrl;

// Pre-created test user IDs
let adminUser;
let agentUser;
let customerUser;
let deactivatedUser;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Ensure case-insensitive unique index exists
  await database.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique_ci ON categories (LOWER(name))"
  );

  const timestamp = Date.now();

  // Create test admin user
  const adminRes = await database.query(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, is_active`,
    [`Admin_${timestamp}`, `admin_${timestamp}@example.com`, "hash", "ADMIN", true]
  );
  adminUser = adminRes.rows[0];

  // Create test agent user
  const agentRes = await database.query(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, is_active`,
    [`Agent_${timestamp}`, `agent_${timestamp}@example.com`, "hash", "AGENT", true]
  );
  agentUser = agentRes.rows[0];

  // Create test customer user
  const customerRes = await database.query(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, is_active`,
    [`Customer_${timestamp}`, `customer_${timestamp}@example.com`, "hash", "CUSTOMER", true]
  );
  customerUser = customerRes.rows[0];

  // Create test deactivated user
  const deactivatedRes = await database.query(
    `INSERT INTO users (name, email, password_hash, role, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, role, is_active`,
    [`Deact_${timestamp}`, `deact_${timestamp}@example.com`, "hash", "CUSTOMER", false]
  );
  deactivatedUser = deactivatedRes.rows[0];
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

function uniqueCategoryName(prefix = "Cat") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function request(path, options = {}) {
  const { method = "GET", user, headers = {}, body } = options;

  const reqHeaders = { ...headers };
  if (user) {
    reqHeaders["Authorization"] = `Bearer ${user.id}`;
  }
  if (body !== undefined && !reqHeaders["Content-Type"]) {
    reqHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Tests: Authentication & Authorization
// ---------------------------------------------------------------------------

test("unauthenticated request to categories returns 401", async () => {
  const { status, body } = await request("/api/v1/categories");
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

test("request with invalid user credentials returns 401", async () => {
  const { status, body } = await request("/api/v1/categories", {
    headers: { Authorization: "Bearer 999999999" },
  });
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

test("request from a deactivated user returns 401", async () => {
  const { status, body } = await request("/api/v1/categories", {
    user: deactivatedUser,
  });
  assert.equal(status, 401);
  assert.equal(body.status, "error");
});

test("customer attempting to create category returns 403", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: customerUser,
    body: { name: uniqueCategoryName() },
  });
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("agent attempting to create category returns 403", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: agentUser,
    body: { name: uniqueCategoryName() },
  });
  assert.equal(status, 403);
  assert.equal(body.status, "error");
});

test("server ignores client-spoofed role headers and blocks unauthorized modifications", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: customerUser,
    headers: {
      "x-user-role": "ADMIN",
      "role": "ADMIN",
    },
    body: { name: uniqueCategoryName(), role: "ADMIN" },
  });
  assert.equal(status, 403, "Customer with spoofed admin role must be rejected with 403");
  assert.equal(body.status, "error");
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/categories (Admin Category Creation)
// ---------------------------------------------------------------------------

test("admin can create category successfully with default is_active=true", async () => {
  const name = uniqueCategoryName("Hardware");
  const description = "Hardware support issues";

  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name, description },
  });

  assert.equal(status, 201);
  assert.equal(body.status, "success");
  const cat = body.data.category;
  assert.equal(cat.name, name);
  assert.equal(cat.description, description);
  assert.equal(cat.is_active, true);
  assert.ok(cat.id);
  assert.ok(cat.created_at);
  assert.ok(cat.updated_at);
});

test("admin can create category with explicit is_active=false", async () => {
  const name = uniqueCategoryName("Legacy");

  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name, is_active: false },
  });

  assert.equal(status, 201);
  assert.equal(body.data.category.is_active, false);
});

test("POST fails when required name is missing", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { description: "Missing name" },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "name"));
});

test("POST fails with whitespace-only name", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: "    " },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "name"));
});

test("POST fails when name exceeds 80 characters", async () => {
  const longName = "A".repeat(81);
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: longName },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "name"));
});

test("POST fails when description exceeds 500 characters", async () => {
  const longDesc = "D".repeat(501);
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName(), description: longDesc },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "description"));
});

test("POST fails when is_active is not a boolean", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName(), is_active: "true" },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "is_active"));
});

test("POST fails when unknown fields are present", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName(), unexpectedField: "hack" },
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
  assert.ok(body.errors.some((e) => e.field === "unexpectedField"));
});

test("POST fails with empty request body", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: {},
  });

  assert.equal(status, 422);
  assert.equal(body.status, "error");
});

test("POST fails with malformed JSON body", async () => {
  const { status, body } = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    headers: { "Content-Type": "application/json" },
    body: "{ malformed json",
  });

  assert.equal(status, 400);
  assert.equal(body.status, "error");
  assert.equal(body.message, "Malformed JSON in request body");
});

// ---------------------------------------------------------------------------
// Tests: Duplicate Name & Case-Insensitive Uniqueness
// ---------------------------------------------------------------------------

test("exact-case duplicate category returns 409 Conflict", async () => {
  const name = uniqueCategoryName("DupExact");

  const first = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name },
  });
  assert.equal(first.status, 201);

  const duplicate = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.status, "error");
});

test("case-insensitive duplicate category returns 409 Conflict", async () => {
  const baseName = uniqueCategoryName("Network");

  const first = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: baseName.toLowerCase() },
  });
  assert.equal(first.status, 201);

  // Attempt duplicate in UPPERCASE
  const upper = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: baseName.toUpperCase() },
  });
  assert.equal(upper.status, 409);
  assert.equal(upper.body.status, "error");

  // Attempt duplicate with extra surrounding spaces
  const spaced = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: `   ${baseName.toLowerCase()}   ` },
  });
  assert.equal(spaced.status, 409);
});

test("concurrent duplicate category creations: only one succeeds, others return 409", async () => {
  const name = uniqueCategoryName("ConcurrentCat");

  const results = await Promise.all([
    request("/api/v1/categories", { method: "POST", user: adminUser, body: { name: name.toLowerCase() } }),
    request("/api/v1/categories", { method: "POST", user: adminUser, body: { name: name.toUpperCase() } }),
    request("/api/v1/categories", { method: "POST", user: adminUser, body: { name } }),
  ]);

  const successes = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);

  assert.equal(successes.length, 1, `Only one request should succeed, got ${successes.length}`);
  assert.equal(conflicts.length, 2, `Other requests must conflict with 409, got ${conflicts.length}`);
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/categories (List Categories with Role Scoping)
// ---------------------------------------------------------------------------

test("customer and agent only see active categories on GET /", async () => {
  const activeName = uniqueCategoryName("ActiveCat");
  const inactiveName = uniqueCategoryName("InactiveCat");

  // Create one active and one inactive category
  const activeRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: activeName, is_active: true },
  });
  const inactiveRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: inactiveName, is_active: false },
  });

  const activeId = activeRes.body.data.category.id;
  const inactiveId = inactiveRes.body.data.category.id;

  // Customer listing
  const customerList = await request("/api/v1/categories", { user: customerUser });
  assert.equal(customerList.status, 200);
  const customerCatIds = customerList.body.data.categories.map((c) => String(c.id));
  assert.ok(customerCatIds.includes(String(activeId)));
  assert.ok(!customerCatIds.includes(String(inactiveId)), "Inactive category must NOT be visible to customer");

  // Agent listing
  const agentList = await request("/api/v1/categories", { user: agentUser });
  assert.equal(agentList.status, 200);
  const agentCatIds = agentList.body.data.categories.map((c) => String(c.id));
  assert.ok(agentCatIds.includes(String(activeId)));
  assert.ok(!agentCatIds.includes(String(inactiveId)), "Inactive category must NOT be visible to agent");

  // Customer passing include_inactive / is_active query params still cannot see inactive
  const customerFiltered = await request("/api/v1/categories?is_active=false", { user: customerUser });
  assert.equal(customerFiltered.status, 200);
  const custFilteredIds = customerFiltered.body.data.categories.map((c) => String(c.id));
  assert.ok(!custFilteredIds.includes(String(inactiveId)), "Customer must never see inactive categories");
});

test("admin can view all categories including inactive ones on GET /", async () => {
  const inactiveName = uniqueCategoryName("AdminInactiveCat");
  const inactiveRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: inactiveName, is_active: false },
  });
  const inactiveId = inactiveRes.body.data.category.id;

  const adminList = await request("/api/v1/categories", { user: adminUser });
  assert.equal(adminList.status, 200);
  const adminCatIds = adminList.body.data.categories.map((c) => String(c.id));
  assert.ok(adminCatIds.includes(String(inactiveId)), "Admin must be able to view inactive category");
});

test("admin can filter categories by ?is_active=true and ?is_active=false", async () => {
  const activeRes = await request("/api/v1/categories?is_active=true", { user: adminUser });
  assert.equal(activeRes.status, 200);
  for (const cat of activeRes.body.data.categories) {
    assert.equal(cat.is_active, true);
  }

  const inactiveRes = await request("/api/v1/categories?is_active=false", { user: adminUser });
  assert.equal(inactiveRes.status, 200);
  for (const cat of inactiveRes.body.data.categories) {
    assert.equal(cat.is_active, false);
  }
});

test("GET / with invalid is_active query parameter returns 400 Bad Request", async () => {
  const { status, body } = await request("/api/v1/categories?is_active=notabool", { user: adminUser });
  assert.equal(status, 400);
  assert.equal(body.status, "error");
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/categories/:id
// ---------------------------------------------------------------------------

test("GET /:id with invalid ID format returns 400 Bad Request", async () => {
  const invalidIds = ["abc", "-5", "0", "1.5", "null", "undefined"];
  for (const id of invalidIds) {
    const { status, body } = await request(`/api/v1/categories/${id}`, { user: customerUser });
    assert.equal(status, 400, `Expected 400 for id "${id}", got ${status}`);
    assert.equal(body.status, "error");
  }
});

test("GET /:id with non-existent ID returns 404 Not Found", async () => {
  const { status, body } = await request("/api/v1/categories/99999999", { user: adminUser });
  assert.equal(status, 404);
  assert.equal(body.status, "error");
});

test("customer and agent can retrieve active category by ID (200)", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("ActiveGet") },
  });
  const id = createRes.body.data.category.id;

  const custRes = await request(`/api/v1/categories/${id}`, { user: customerUser });
  assert.equal(custRes.status, 200);
  assert.equal(custRes.body.data.category.id, id);

  const agentRes = await request(`/api/v1/categories/${id}`, { user: agentUser });
  assert.equal(agentRes.status, 200);
  assert.equal(agentRes.body.data.category.id, id);
});

test("inactive category returns 404 for customer and agent, but 200 for admin", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("InactiveGet"), is_active: false },
  });
  const id = createRes.body.data.category.id;

  // Customer receives 404
  const custRes = await request(`/api/v1/categories/${id}`, { user: customerUser });
  assert.equal(custRes.status, 404);
  assert.equal(custRes.body.status, "error");

  // Agent receives 404
  const agentRes = await request(`/api/v1/categories/${id}`, { user: agentUser });
  assert.equal(agentRes.status, 404);
  assert.equal(agentRes.body.status, "error");

  // Admin receives 200
  const adminRes = await request(`/api/v1/categories/${id}`, { user: adminUser });
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.body.data.category.id, id);
  assert.equal(adminRes.body.data.category.is_active, false);
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/v1/categories/:id (Update Category)
// ---------------------------------------------------------------------------

test("customer and agent cannot PATCH category (403)", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("PatchAuth") },
  });
  const id = createRes.body.data.category.id;

  const custRes = await request(`/api/v1/categories/${id}`, {
    method: "PATCH",
    user: customerUser,
    body: { name: "Updated" },
  });
  assert.equal(custRes.status, 403);

  const agentRes = await request(`/api/v1/categories/${id}`, {
    method: "PATCH",
    user: agentUser,
    body: { name: "Updated" },
  });
  assert.equal(agentRes.status, 403);
});

test("admin can update category name, description, and status with updated_at refreshed", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("OrigName"), description: "Orig Desc" },
  });
  const id = createRes.body.data.category.id;
  const originalUpdatedAt = createRes.body.data.category.updated_at;

  // Small delay to ensure timestamp progression
  await new Promise((r) => setTimeout(r, 20));

  const newName = uniqueCategoryName("NewName");
  const updateRes = await request(`/api/v1/categories/${id}`, {
    method: "PATCH",
    user: adminUser,
    body: { name: newName, description: "New Desc", is_active: false },
  });

  assert.equal(updateRes.status, 200);
  const updated = updateRes.body.data.category;
  assert.equal(updated.name, newName);
  assert.equal(updated.description, "New Desc");
  assert.equal(updated.is_active, false);
  assert.notEqual(updated.updated_at, originalUpdatedAt);
});

test("PATCH category fails when updating to an existing category name (409)", async () => {
  const name1 = uniqueCategoryName("NameA");
  const name2 = uniqueCategoryName("NameB");

  await request("/api/v1/categories", { method: "POST", user: adminUser, body: { name: name1 } });
  const cat2 = await request("/api/v1/categories", { method: "POST", user: adminUser, body: { name: name2 } });
  const id2 = cat2.body.data.category.id;

  // Attempt to update cat2 to name1 (case-insensitive)
  const dupRes = await request(`/api/v1/categories/${id2}`, {
    method: "PATCH",
    user: adminUser,
    body: { name: name1.toUpperCase() },
  });
  assert.equal(dupRes.status, 409);
});

test("PATCH category fails with empty update body (422)", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("EmptyPatch") },
  });
  const id = createRes.body.data.category.id;

  const { status, body } = await request(`/api/v1/categories/${id}`, {
    method: "PATCH",
    user: adminUser,
    body: {},
  });
  assert.equal(status, 422);
  assert.equal(body.status, "error");
});

test("PATCH category fails with unknown fields (422)", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("UnknownPatch") },
  });
  const id = createRes.body.data.category.id;

  const { status, body } = await request(`/api/v1/categories/${id}`, {
    method: "PATCH",
    user: adminUser,
    body: { name: "ValidName", extraField: "not_allowed" },
  });
  assert.equal(status, 422);
  assert.ok(body.errors.some((e) => e.field === "extraField"));
});

test("PATCH category on non-existent ID returns 404", async () => {
  const { status } = await request("/api/v1/categories/99999999", {
    method: "PATCH",
    user: adminUser,
    body: { name: "NonExistent" },
  });
  assert.equal(status, 404);
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/v1/categories/:id/status (Activate / Deactivate)
// ---------------------------------------------------------------------------

test("admin can deactivate and re-activate a category via /:id/status", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("StatusToggle"), is_active: true },
  });
  const id = createRes.body.data.category.id;

  // Deactivate
  const deactRes = await request(`/api/v1/categories/${id}/status`, {
    method: "PATCH",
    user: adminUser,
    body: { is_active: false },
  });
  assert.equal(deactRes.status, 200);
  assert.equal(deactRes.body.data.category.is_active, false);

  // Activate
  const actRes = await request(`/api/v1/categories/${id}/status`, {
    method: "PATCH",
    user: adminUser,
    body: { is_active: true },
  });
  assert.equal(actRes.status, 200);
  assert.equal(actRes.body.data.category.is_active, true);
});

test("PATCH /:id/status fails with missing or invalid is_active (422)", async () => {
  const createRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("StatusInvalid") },
  });
  const id = createRes.body.data.category.id;

  // Missing
  const missingRes = await request(`/api/v1/categories/${id}/status`, {
    method: "PATCH",
    user: adminUser,
    body: {},
  });
  assert.equal(missingRes.status, 422);

  // Non-boolean
  const stringRes = await request(`/api/v1/categories/${id}/status`, {
    method: "PATCH",
    user: adminUser,
    body: { is_active: "false" },
  });
  assert.equal(stringRes.status, 422);
});

// ---------------------------------------------------------------------------
// Tests: Requirement 8 - Inactive categories and ticket creation & history
// ---------------------------------------------------------------------------

test("existing tickets retain deactivated category reference without breaking history", async () => {
  // 1. Admin creates active category
  const catRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("TicketHistCat") },
  });
  const categoryId = catRes.body.data.category.id;

  // 2. Create ticket with active category
  const ticket = await ticketService.createTicket({
    title: "Issue with hardware",
    description: "Laptop screen flickering",
    customer_id: customerUser.id,
    category_id: categoryId,
  });
  assert.ok(ticket.id);
  assert.equal(String(ticket.category_id), String(categoryId));

  // 3. Admin deactivates category
  const deactRes = await request(`/api/v1/categories/${categoryId}/status`, {
    method: "PATCH",
    user: adminUser,
    body: { is_active: false },
  });
  assert.equal(deactRes.status, 200);
  assert.equal(deactRes.body.data.category.is_active, false);

  // 4. Ticket still references the deactivated category in database
  const { rows } = await database.query("SELECT * FROM tickets WHERE id = $1", [ticket.id]);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].category_id), String(categoryId), "Ticket category_id must remain preserved");
});

test("creating a new ticket with an inactive category is rejected", async () => {
  // Create an inactive category
  const catRes = await request("/api/v1/categories", {
    method: "POST",
    user: adminUser,
    body: { name: uniqueCategoryName("InactiveTicketCat"), is_active: false },
  });
  const categoryId = catRes.body.data.category.id;

  // Attempt ticket creation
  await assert.rejects(
    async () => {
      await ticketService.createTicket({
        title: "New issue",
        description: "Trying to use inactive category",
        customer_id: customerUser.id,
        category_id: categoryId,
      });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /inactive category/i);
      return true;
    }
  );
});

test("creating a ticket with non-existent category ID is rejected with 404", async () => {
  await assert.rejects(
    async () => {
      await ticketService.createTicket({
        title: "Nonexistent Cat Ticket",
        description: "Invalid category",
        customer_id: customerUser.id,
        category_id: 99999999,
      });
    },
    (err) => {
      assert.equal(err.statusCode, 404);
      return true;
    }
  );
});

test("database query failure returns 500 Internal Server Error with consistent format", async () => {
  const originalQuery = database.query;
  database.query = async (text, ...args) => {
    if (typeof text === "string" && text.includes("FROM categories WHERE id = $1")) {
      throw new Error("Simulated database failure");
    }
    return originalQuery.call(database, text, ...args);
  };

  try {
    const { status, body } = await request("/api/v1/categories/1", { user: customerUser });
    assert.equal(status, 500);
    assert.equal(body.status, "error");
    assert.equal(body.message, "Internal server error");
  } finally {
    database.query = originalQuery;
  }
});
