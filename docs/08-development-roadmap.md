# 08 — Development Roadmap

This document describes the phased plan for building AI Help Desk from its current state to a complete MVP. Each phase has clear objectives, tasks, dependencies, deliverables, acceptance criteria, and suggested tests.

---

## How to Read This Document

- **Completed** — The code exists and the tests pass.
- **Partially completed** — Some code exists but the phase is not finished.
- **Planned** — Not yet started.

Phases must generally be completed in order because later phases depend on earlier ones.

---

## Current Project State (Before Phase 1 Begins)

The following is already done and does not need to be repeated:

| Component | State |
|---|---|
| Backend folder structure and module layout | Complete |
| PostgreSQL schema (all 6 tables) | Complete — `migrations/1792999534510_initial-schema.sql` |
| Environment configuration and validation | Complete — `config/env.js` |
| PostgreSQL connection pool | Complete — `config/database.js` |
| Session middleware with PostgreSQL store | Complete — `config/session.js` |
| Security middleware (Helmet, CORS, body limit) | Complete — `app.js` |
| Global error handler | Complete — `middleware/errorHandler.js` |
| Authentication middleware | Complete — `middleware/authenticate.js` |
| Authorization middleware | Complete — `middleware/authorize.js` |
| Validation middleware | Complete — `middleware/validate.js` |
| `ApiError` utility | Complete |
| `asyncHandler` utility | Complete |
| Auth module (register, login, me, logout) | Complete |
| Category module (CRUD + status toggle) | Complete |
| Auth integration tests | Complete |
| Category integration tests | Complete |
| Health check endpoint | Complete |
| ESLint configuration | Complete |

---

## Phase 1 — Verify Existing Implementation

**Status:** Mostly complete. One item needs resolution.

### Objective
Confirm that what exists works correctly and that there are no hidden issues before building on top of it.

### Tasks

1. **Resolve the migration situation.** Two migration files exist:
   - `1729522800000_create-users-table.js` — An earlier `node-pg-migrate` JS migration that creates a `users` table with a different schema (UUID primary key, `user` role enum instead of VARCHAR).
   - `1792999534510_initial-schema.sql` — The current SQL migration that creates all six tables with the correct schema.

   These two files define the `users` table differently. Running both will fail or produce an inconsistent schema. Recommended action: determine which migration is authoritative, reconcile or remove the older one, and document the migration history.

2. Run the existing tests against the real database: `npm test`
3. Run the linter: `npm run lint`
4. Confirm the health endpoint responds: `curl http://localhost:3000/api/v1/health`

### Acceptance Criteria
- All existing tests pass.
- The linter reports no errors.
- The migration issue is resolved and documented.

### Tests
- `src/tests/health.test.js` — already written
- `src/tests/auth.test.js` — already written
- `src/tests/auth.register.test.js` — already written
- `src/tests/categories.test.js` — already written

---

## Phase 2 — Ticket Creation and Retrieval

**Status:** Planned. The `ticket.service.js` has a `createTicket` function and the schema exists.

### Objective
Allow customers to create tickets and view their own tickets. Allow agents and admins to view tickets relevant to them.

### Dependencies
Phase 1 complete.

### Tasks

1. Add validation schema to `ticket.validation.js` for ticket creation.
2. Implement `ticket.controller.js`:
   - `createTicket` — validates input, sets `customer_id = req.user.id`, calls service.
   - `listTickets` — role-dependent query (customer: own; agent: assigned; admin: all).
   - `getTicketById` — ownership check for customers.
3. Wire routes in `ticket.routes.js`:
   - `POST /` — requires `CUSTOMER` or `ADMIN` role
   - `GET /` — requires any authenticated role
   - `GET /:id` — requires any authenticated role, enforces ownership for customers
4. Write integration tests in `src/tests/tickets.test.js`.

### Expected Deliverable
A customer can create a ticket via the API and retrieve it. An agent cannot create a ticket. A customer cannot read another customer's ticket.

### Acceptance Criteria
- `POST /api/v1/tickets` with valid data from a customer returns `201 Created` with the ticket.
- `GET /api/v1/tickets` for a customer returns only their own tickets.
- `GET /api/v1/tickets/:id` for a customer with someone else's ticket ID returns `403` or `404`.
- `POST /api/v1/tickets` from an agent returns `403`.
- Creating a ticket with an inactive category returns `400`.
- Creating a ticket with a non-existent category returns `404`.
- Missing title or description returns `422`.

### Tests
- Ticket creation: success, missing fields, inactive category, non-existent category
- Ticket listing: customer sees own, agent sees assigned (empty until phase 3), admin sees all
- Ticket detail: ownership enforcement
- Unauthorized access

---

## Phase 3 — Ticket Status, Assignment, and History

**Status:** Planned.

### Objective
Allow agents to update ticket status. Allow admins to assign tickets. Record all changes in `ticket_history`.

### Dependencies
Phase 2 complete.

### Tasks

1. Add status update route: `PATCH /api/v1/tickets/:id/status`
   - Validates new status is a valid value.
   - Sets `resolved_at` when status becomes `RESOLVED`.
   - Sets `closed_at` when status becomes `CLOSED`.
   - Inserts a row into `ticket_history`.
   - Returns the updated ticket.
2. Add assignment route: `PATCH /api/v1/tickets/:id/assignment`
   - Admin only.
   - Validates `assigned_agent_id` references a user with `AGENT` role.
   - Inserts a `ticket_history` row.
3. Add history retrieval route: `GET /api/v1/tickets/:id/history`
   - Agent and admin only.
4. Consider using a database transaction for the `UPDATE tickets + INSERT ticket_history` pattern to ensure both succeed or both fail together.
5. Write integration tests in `src/tests/tickets.test.js`.

### Expected Deliverable
An agent can change a ticket's status. An admin can assign a ticket. All changes are recorded.

### Acceptance Criteria
- `PATCH /api/v1/tickets/:id/status` to `RESOLVED` sets `resolved_at` and creates a history record.
- `PATCH /api/v1/tickets/:id/status` to `RESOLVED` without `resolved_at` is blocked by the database constraint.
- A customer cannot change ticket status.
- `GET /api/v1/tickets/:id/history` returns history for agents and admins.
- A customer cannot access the history endpoint.

---

## Phase 4 — Comments

**Status:** Planned.

### Objective
Allow customers and agents to communicate on a ticket through comments.

### Dependencies
Phase 2 complete.

### Tasks

1. Implement `comment.service.js`:
   - `listComments(ticketId, role)` — filters out `is_internal = true` for customers.
   - `addComment(ticketId, authorId, message, isInternal)` — validates ticket exists and caller has access.
2. Implement `comment.controller.js` and `comment.routes.js`:
   - `GET /api/v1/tickets/:id/comments`
   - `POST /api/v1/tickets/:id/comments`
3. Enforce: customers cannot set `is_internal = true`.
4. Write tests in `src/tests/comments.test.js`.

### Acceptance Criteria
- A customer can add a comment to their own ticket.
- An agent can add an internal comment that a customer cannot see.
- A customer cannot add an internal comment.
- A customer cannot comment on a ticket they do not own.

---

## Phase 5 — User Management

**Status:** Planned.

### Objective
Allow admins to list users, change roles, and deactivate accounts.

### Dependencies
Phase 1 complete.

### Tasks

1. Implement `user.service.js`:
   - `listUsers()` — returns all users with safe fields (no `password_hash`).
   - `updateUserRole(userId, newRole)` — validates role value, updates the database.
   - `setUserActive(userId, isActive)` — deactivates or reactivates an account.
2. Implement `user.controller.js` and `user.routes.js`:
   - `GET /api/v1/users` (admin only)
   - `PATCH /api/v1/users/:id/role` (admin only)
3. Wire `user.routes.js` into `app.js`.
4. Write tests in `src/tests/users.test.js`.

### Acceptance Criteria
- Admin can list all users.
- Admin can change a user's role from `CUSTOMER` to `AGENT`.
- A non-admin cannot access user management endpoints.
- A deactivated user's existing sessions return `401` on the next request (enforced by `authenticate.js` already).

---

## Phase 6 — AI Integration

**Status:** Planned.

### Objective
Allow agents to request AI-generated suggestions for ticket classification and reply drafts.

### Dependencies
Phases 2 and 3 complete (tickets must exist). A configured AI provider API key.

### Tasks

1. Choose an AI provider and obtain an API key.
2. Add `AI_API_KEY` and optionally `AI_MODEL_NAME` to `.env.example`.
3. Implement `ai.provider.js`:
   - Wraps the API call to the chosen provider.
   - Handles timeouts (e.g., 15 seconds).
   - Validates the response shape.
   - Converts provider errors to `ApiError`.
4. Implement `ai.service.js`:
   - `classifyTicket(ticketId, requestedBy)` — fetches ticket, calls provider, saves to `ai_suggestions`.
   - `generateReplyDraft(ticketId, requestedBy)` — fetches ticket + comments, calls provider, saves result.
5. Implement `ai.controller.js` and `ai.routes.js`:
   - `POST /api/v1/ai/classify-ticket`
   - `POST /api/v1/tickets/:id/ai-reply`
6. Wire `ai.routes.js` into `app.js`.
7. Add a review endpoint: `PATCH /api/v1/ai/suggestions/:id/review`.
8. Write tests with a mocked AI provider in `src/tests/ai.test.js`.

### Acceptance Criteria
- An agent can request a classification and receive a `PENDING` suggestion.
- The suggestion is stored in `ai_suggestions` with the correct fields.
- The ticket is not modified automatically.
- An agent can accept or reject the suggestion.
- A customer cannot access AI endpoints.
- A provider timeout returns a sensible error, not a crash.

---

## Phase 7 — Dashboard

**Status:** Planned.

### Objective
Provide agents and admins with a summary of ticket counts by status.

### Dependencies
Phases 2 and 3 complete.

### Tasks

1. Implement `dashboard.service.js`:
   - Query ticket counts grouped by `status`.
   - Optionally include counts by `priority` or `category`.
2. Implement `dashboard.controller.js` and `dashboard.routes.js`:
   - `GET /api/v1/dashboard/summary` (agent and admin)
3. Wire into `app.js`.
4. Write tests.

---

## Phase 8 — React Frontend

**Status:** Planned. The `frontend/` directory exists but is empty.

### Objective
Build a React.js frontend that connects to the backend API.

### Dependencies
Phases 1–5 complete (core API is stable).

### Tasks

1. Initialize a React project (Vite + React.js + JavaScript).
2. Install React Query for server state management.
3. Implement pages:
   - Login / Register
   - Customer: ticket list, create ticket, ticket detail, add comment
   - Agent: assigned ticket list, ticket detail, update status, add comment, view AI suggestions
   - Admin: all ticket list, assign ticket, category management, user management
4. Configure `fetch` to send cookies with every request (`credentials: "include"`).
5. Add frontend route guards that redirect unauthenticated users to the login page.
6. Handle `401` responses globally: redirect to login.

---

## Phase 9 — Testing, Security Hardening, and Deployment

**Status:** Partially started (tests exist; deployment not configured).

### Objective
Ensure the system is well-tested, secure, and deployable.

### Tasks

1. Write tests for all planned modules that do not yet have tests.
2. Confirm all test files run to completion: `npm test`.
3. Run the linter on the full codebase: `npm run lint`.
4. Resolve the migration file conflict (see Phase 1, Task 1).
5. Prepare production environment variables.
6. Configure HTTPS and ensure `secure: true` on cookies.
7. Set `FRONTEND_ORIGIN` to the deployed frontend URL.
8. Deploy the backend to a hosting platform.
9. Run a final round of manual acceptance testing against the deployed environment.

---

*Previous: [07 — AI Integration](./07-ai-integration.md) | Next: [09 — Testing Strategy](./09-testing-strategy.md)*

