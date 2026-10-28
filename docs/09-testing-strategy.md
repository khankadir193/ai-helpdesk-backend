# 09 — Testing Strategy

This document explains how to verify that the system behaves correctly, what to test, and how to interpret test results.

---

## Important Distinction

> A **written test** is a test that exists in a file. A **passing test** is a test that has been executed and produced a green result against the actual system. These are not the same thing.
>
> This document describes tests that should be written and tests that exist. It does not claim any test has passed unless it has been explicitly verified by running `npm test`.

---

## Test Runner

The project uses **Node.js built-in test runner** (`node:test`) with `node:assert/strict`. No external test framework (such as Jest or Mocha) is required.

Tests are run with:

```powershell
npm test
# expands to:
cross-env NODE_ENV=test node --test src/tests/**/*.test.js
```

Individual test files can be run directly:

```powershell
node --test src/tests/auth.test.js
node --test src/tests/categories.test.js
```

---

## Test Types Used

### Integration Tests
The existing tests are integration tests: they start the real Express server, connect to the real PostgreSQL database, send real HTTP requests, and assert on real responses. There are no mocks for the database or HTTP layer.

**Why integration tests rather than unit tests?**
For a small API with straightforward business logic, integration tests provide more confidence that the complete system works correctly. They catch issues that unit tests miss: SQL mistakes, middleware ordering errors, and cookie behavior.

A trade-off is that integration tests are slower than unit tests and require a running database. For this project's scope, the trade-off is acceptable.

### Unit Tests *(Planned)*
As business logic grows in complexity (e.g., status transition rules, AI response validation), pure unit tests for individual service functions become valuable. These tests call the function directly without HTTP or database involvement.

---

## Existing Tests

### `src/tests/health.test.js` — Health Check
- `GET /api/v1/health` returns `200` with `{ status: "ok", timestamp: "<ISO8601>" }`.
- An unknown route returns `404` with `{ status: "error", message: "Route not found" }`.

### `src/tests/auth.register.test.js` — Registration
- Successful registration returns `201` with a user object.
- `password_hash` is not returned in the response.
- Duplicate email (exact case) returns `409`.
- Duplicate email (uppercase) returns `409`.
- Duplicate email (mixed case) returns `409`.
- Concurrent duplicate registrations: exactly one succeeds, others return `409`.
- Duplicate attempt does not insert a second user record.

### `src/tests/auth.test.js` — Full Authentication Flow
All of the above, plus:

**Registration:**
- Role is always set by the server; client-supplied role is ignored.
- Missing name returns `422`.
- Whitespace-only name returns `422`.
- Invalid email format returns `422`.
- Password too short returns `422`.
- Password too long returns `422`.

**Login:**
- Successful login returns `200` and sets `helpdesk.sid` `HttpOnly` cookie.
- Wrong password returns `401` with generic message.
- Non-existent email returns `401` with generic message.
- Deactivated account returns `401`.
- Login with uppercase email succeeds (case-insensitive normalization).
- Missing email returns `422`.
- Missing password returns `422`.

**GET /me:**
- Without session returns `401`.
- With invalid session cookie returns `401`.
- After successful login returns `200` with profile.
- `password_hash` not in `/me` response.
- Session persists across multiple requests.
- Two logins produce different session IDs (session regeneration).

**Logout:**
- Logout returns `200`. Subsequent `/me` returns `401`.
- Logout is safe without a session (idempotent).
- Protected route is inaccessible after logout.

**Role spoofing:**
- Attempting to set role via request headers is ignored; `403` is returned for unauthorized actions.

### `src/tests/categories.test.js` — Category Management

**Authentication and authorization:**
- Unauthenticated request returns `401`.
- Invalid session cookie returns `401`.
- Deactivated user returns `401`.
- Customer creating category returns `403`.
- Agent creating category returns `403`.
- Spoofed role headers are ignored.

**Category creation (admin only):**
- Successful creation with defaults.
- Creation with `is_active: false`.
- Missing name returns `422`.
- Whitespace-only name returns `422`.
- Name exceeding 80 chars returns `422`.
- Description exceeding 500 chars returns `422`.
- Non-boolean `is_active` returns `422`.
- Unknown fields return `422`.
- Empty body returns `422`.
- Malformed JSON returns `400`.

**Uniqueness:**
- Exact-case duplicate returns `409`.
- Case-insensitive duplicate returns `409`.
- Concurrent duplicate creations: exactly one succeeds.

**Category listing:**
- Customer and agent see only active categories.
- Admin sees all categories.
- Admin can filter by `?is_active=true` or `?is_active=false`.
- Customer with `?is_active=false` still sees only active categories.
- Invalid `is_active` query parameter returns `400`.

**Category retrieval by ID:**
- Invalid ID format (non-integer, zero, negative) returns `400`.
- Non-existent ID returns `404`.
- Active category: customer and agent receive `200`.
- Inactive category: customer and agent receive `404`; admin receives `200`.

**Category update (PATCH):**
- Customer and agent updating category returns `403`.
- Admin updates name, description, and status; `updated_at` is refreshed.
- Updating to a conflicting name returns `409`.
- Empty body returns `422`.
- Unknown fields return `422`.
- Non-existent ID returns `404`.

**Category status toggle:**
- Admin can deactivate and re-activate a category.
- Missing or non-boolean `is_active` returns `422`.

**Ticket and category interaction:**
- Existing tickets retain their `category_id` after the category is deactivated.
- Creating a new ticket with an inactive category returns `400`.
- Creating a ticket with a non-existent category returns `404`.

**Database failure simulation:**
- Simulated database failure returns `500` with consistent format.

---

## Tests Still to Be Written

### Tickets (`src/tests/tickets.test.js`) — Planned

| Scenario | Expected Result |
|---|---|
| Customer creates ticket with valid data | `201 Created` |
| Customer creates ticket with inactive category | `400 Bad Request` |
| Customer creates ticket with non-existent category | `404 Not Found` |
| Customer creates ticket with missing title | `422` |
| Agent creating ticket | `403 Forbidden` |
| Customer lists own tickets | `200`, only own tickets |
| Customer retrieves their own ticket by ID | `200` |
| Customer retrieves another customer's ticket by ID | `403` or `404` |
| Admin retrieves any ticket | `200` |
| Agent updates ticket status | `200`, history recorded |
| Agent updates status to `RESOLVED` | `resolved_at` is set |
| Customer updates ticket status | `403 Forbidden` |
| Admin assigns ticket to agent | `200`, history recorded |
| Admin assigns ticket to a non-agent user | `400` or `422` |
| Retrieve ticket history | `200` for agent/admin; `403` for customer |

### Comments (`src/tests/comments.test.js`) — Planned

| Scenario | Expected Result |
|---|---|
| Customer adds comment to own ticket | `201 Created` |
| Customer adds comment to another's ticket | `403` or `404` |
| Customer attempts `is_internal: true` | `403 Forbidden` |
| Agent adds internal comment | `201 Created` |
| Customer lists comments (internal excluded) | `200`, no internal comments |
| Agent lists comments (internal included) | `200`, includes internal comments |

### Users (`src/tests/users.test.js`) — Planned

| Scenario | Expected Result |
|---|---|
| Admin lists users | `200`, no `password_hash` in any record |
| Customer accessing user list | `403 Forbidden` |
| Admin changes user role | `200`, role updated |
| Admin deactivates user | `200`; user's subsequent requests return `401` |

### AI (`src/tests/ai.test.js`) — Planned

| Scenario | Expected Result |
|---|---|
| Agent requests classification | `200`, suggestion stored as `PENDING` |
| Ticket not modified by classification | Original ticket fields unchanged |
| Customer requests AI classification | `403 Forbidden` |
| Agent reviews suggestion (accept) | `200`, `status = 'ACCEPTED'`, `reviewed_by` set |
| AI provider timeout | Graceful error, not a crash |
| AI provider returns invalid response shape | `502 Bad Gateway` or `503` |

---

## Test Scenarios by Topic

### Authentication and Sessions
1. A fresh registration followed by login and `/me` returns the correct user.
2. Logging out invalidates the session; the old cookie is rejected.
3. Two simultaneous logins produce different session IDs.
4. An account deactivated mid-session causes the next request to return `401`.
5. A deleted user's session is invalidated on the next request.

### Authorization and Role Enforcement
1. A customer with a valid session cannot access admin-only routes.
2. Sending a role header (e.g., `X-User-Role: ADMIN`) does not grant elevated access.
3. Including `"role": "ADMIN"` in the request body is ignored.
4. An admin can perform all operations a customer or agent can.

### Input Validation
1. Every required field, when missing, produces a `422` with an error for that specific field.
2. A field that exceeds its maximum length produces a `422`.
3. A non-boolean where a boolean is expected produces a `422`.
4. An unknown field in the body produces a `422` (when `rejectUnknown: true` is used).
5. Malformed JSON produces `400`.

### Ticket Ownership Isolation
1. Customer A cannot read Customer B's ticket by ID.
2. Customer A cannot post a comment on Customer B's ticket.
3. The backend enforces this — it is not enough to hide the URL in the frontend.

### Error Handling
1. A simulated database failure returns `500` with `{ status: "error", message: "Internal server error" }`. No stack trace is exposed to the client.
2. A request to an unknown route returns `404` with `{ status: "error", message: "Route not found" }`.

### Regression Testing
After any significant change:
1. Run the full test suite: `npm test`.
2. Run the linter: `npm run lint`.
3. Verify the health endpoint manually.
4. If authentication logic changed, run `auth.test.js` individually and verify all scenarios pass.
5. If category logic changed, run `categories.test.js` individually.

---

## Test Database Hygiene

The test suite uses the same database as development by default (controlled by `DATABASE_URL` in `.env`). Tests insert records during setup and do not clean up after themselves (some tests use `before` hooks to insert test users but no teardown deletes them).

**Recommended practice:**
- Use a separate test database (e.g., `help_desk_test`) with `NODE_ENV=test` pointing to it.
- Add `after` hooks that delete test-created records.
- Use unique names and emails in every test (e.g., suffixed with `Date.now()`) to avoid collisions between test runs.

The existing tests already use `uniqueEmail()` and `uniqueCategoryName()` helpers to avoid collisions.

---

*Previous: [08 — Development Roadmap](./08-development-roadmap.md) | Next: [10 — Deployment and Setup](./10-deployment-and-setup.md)*

