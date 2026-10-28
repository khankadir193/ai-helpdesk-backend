# 02 — Functional and Non-Functional Requirements

This document describes what the application must do (functional requirements) and the quality standards it must meet (non-functional requirements). Every requirement has been verified against the current codebase. Items that are not yet implemented are clearly marked as **Planned**.

---

## Functional Requirements

Functional requirements describe observable behaviors: what a user can do, what the system must do in response, and what the outcome should be.

Requirements are grouped by user role and use identifiers in the format `FR-NNN`.

---

### Customer

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-001 | A customer can register with a name, email address, and password | Must have | **Implemented** |
| FR-002 | Registration rejects a duplicate email address (case-insensitive) | Must have | **Implemented** |
| FR-003 | Registration rejects passwords shorter than 8 characters or longer than 72 characters | Must have | **Implemented** |
| FR-004 | A customer can log in with their email and password | Must have | **Implemented** |
| FR-005 | Login is rejected with a generic error message when credentials are wrong (prevents user enumeration) | Must have | **Implemented** |
| FR-006 | A customer can log out, which destroys the server-side session | Must have | **Implemented** |
| FR-007 | A logged-in customer can retrieve their own profile (`/api/v1/auth/me`) | Must have | **Implemented** |
| FR-008 | A customer can view only the active ticket categories when creating a ticket | Must have | **Implemented** |
| FR-009 | A customer can create a support ticket with a title, description, optional category, and optional priority | Must have | **Planned** |
| FR-010 | A customer can view a list of their own tickets only | Must have | **Planned** |
| FR-011 | A customer can view the full details and current status of one of their own tickets | Must have | **Planned** |
| FR-012 | A customer can add a comment (reply) to one of their own tickets | Must have | **Planned** |
| FR-013 | A customer cannot view another customer's ticket, even by guessing a ticket ID | Must have | **Planned** |
| FR-014 | A customer can view AI-generated suggestions attached to their ticket where the suggestion is not marked internal | Should have | **Planned** |

---

### Support Agent

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-020 | An agent can log in and log out using the same authentication flow as a customer | Must have | **Implemented** |
| FR-021 | An agent can view a list of tickets assigned to them | Must have | **Planned** |
| FR-022 | An agent can view the full details and comment history of an assigned ticket | Must have | **Planned** |
| FR-023 | An agent can post a comment (response) on an assigned ticket | Must have | **Planned** |
| FR-024 | An agent can update the status of a ticket (e.g., from `OPEN` to `IN_PROGRESS`) | Must have | **Planned** |
| FR-025 | An agent can view only active ticket categories | Must have | **Implemented** |
| FR-026 | An agent can view AI-generated suggestions on an assigned ticket | Should have | **Planned** |
| FR-027 | An agent cannot create, update, or delete categories | Must have | **Implemented** |
| FR-028 | An agent cannot access tickets not assigned to them | Must have | **Planned** |
| FR-029 | An agent can mark a ticket as resolved | Must have | **Planned** |

---

### Admin

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-040 | An admin can log in and log out using the same authentication flow | Must have | **Implemented** |
| FR-041 | An admin can create a ticket category with a name and optional description | Must have | **Implemented** |
| FR-042 | An admin can view all categories, including inactive ones | Must have | **Implemented** |
| FR-043 | An admin can update a category's name, description, or active status | Must have | **Implemented** |
| FR-044 | An admin can activate or deactivate a category | Must have | **Implemented** |
| FR-045 | An admin can view all tickets regardless of status or assignment | Must have | **Planned** |
| FR-046 | An admin can assign or reassign a ticket to an agent | Must have | **Planned** |
| FR-047 | An admin can change a user's role | Should have | **Planned** |
| FR-048 | An admin can deactivate a user account | Should have | **Planned** |
| FR-049 | An admin can view the ticket history audit log | Should have | **Planned** |
| FR-050 | An admin can view a dashboard summary of ticket counts by status | Should have | **Planned** |

---

### System — AI Features

| ID | Requirement | Priority | Status |
|---|---|---|---|
| FR-060 | The backend can send ticket data to an AI provider and receive a category suggestion | Should have | **Planned** |
| FR-061 | The backend can request a priority suggestion from the AI provider | Could have | **Planned** |
| FR-062 | The backend can request a reply draft from the AI provider for agent review | Should have | **Planned** |
| FR-063 | The backend can request a conversation summary from the AI provider | Could have | **Planned** |
| FR-064 | AI suggestions are stored in `ai_suggestions` with `PENDING` status until reviewed | Must have | **Planned** |
| FR-065 | An authorized user (agent or admin) can accept or reject an AI suggestion | Must have | **Planned** |
| FR-066 | Accepting an AI suggestion does not automatically update the ticket; the user must apply it manually | Must have | **Planned** |
| FR-067 | AI requests are always made by the backend; the browser never sends requests directly to the AI provider | Must have | **Planned** |

---

## Acceptance Criteria for Key Features

Acceptance criteria describe what must be true for a requirement to be considered met. These are written as observable conditions.

### FR-001 — Customer Registration

- `POST /api/v1/auth/register` with valid `name`, `email`, and `password` returns `201 Created`.
- The response body contains `id`, `name`, `email`, `role`, and `created_at`. It does not contain `password_hash` or `password`.
- The role is always `CUSTOMER` regardless of what the client sends in the body.
- Registering with an email that already exists (in any casing) returns `409 Conflict`.
- Submitting a password shorter than 8 characters returns `422 Unprocessable Content` with a field-level error on `password`.
- Concurrent registration attempts with the same email result in exactly one `201` and all others returning `409`.

### FR-004 — Customer Login

- `POST /api/v1/auth/login` with valid credentials returns `200 OK` and sets an `HttpOnly` session cookie named `helpdesk.sid`.
- The response body includes the user's `id`, `name`, `email`, and `role`. It does not include `password_hash`.
- A wrong password returns `401 Unauthorized` with the message `"Invalid email or password."`.
- A non-existent email returns `401 Unauthorized` with the same generic message (not a different message that reveals whether the email exists).
- A deactivated account returns `401 Unauthorized`.
- The session ID is regenerated on each successful login (prevents session fixation).

### FR-041 — Category Creation

- `POST /api/v1/categories` with a valid `name` by an admin returns `201 Created`.
- A category name that already exists (case-insensitive) returns `409 Conflict`.
- A whitespace-only name returns `422 Unprocessable Content`.
- A customer or agent attempting to create a category returns `403 Forbidden`.
- An unauthenticated request returns `401 Unauthorized`.

### FR-013 — Ticket Ownership Isolation *(Planned)*

- A customer who requests `GET /api/v1/tickets/:id` for a ticket they do not own receives `403 Forbidden` or `404 Not Found`.
- Changing the ID in the URL does not grant access to another customer's ticket.
- This must be enforced in the backend, not only in the frontend.

---

## Non-Functional Requirements

Non-functional requirements define quality standards that apply across the whole system.

### Security

| ID | Requirement | Status |
|---|---|---|
| NFR-S01 | Passwords are hashed with bcrypt at work factor 12 before storage | **Implemented** |
| NFR-S02 | Plaintext passwords and password hashes are never returned in API responses | **Implemented** |
| NFR-S03 | Sessions are stored server-side in PostgreSQL; the cookie contains only a session ID | **Implemented** |
| NFR-S04 | Session cookies are marked `HttpOnly` and `Secure` (in production) | **Implemented** |
| NFR-S05 | The session ID is regenerated after a successful login to prevent session fixation | **Implemented** |
| NFR-S06 | The server always loads the user's role from the database; it never trusts a role sent by the client | **Implemented** |
| NFR-S07 | Login and registration endpoints are rate-limited (10 requests per 15 minutes in production) | **Implemented** |
| NFR-S08 | All SQL queries use parameterized values; no string interpolation is used for user input | **Implemented** |
| NFR-S09 | Helmet middleware sets security-relevant HTTP response headers | **Implemented** |
| NFR-S10 | CORS is restricted to known frontend origins in production | **Implemented** |
| NFR-S11 | Request body size is capped at 100 KB to prevent request-body denial-of-service | **Implemented** |
| NFR-S12 | AI API keys are stored in environment variables and never sent to the browser | **Planned** |

### Data Integrity

| ID | Requirement | Status |
|---|---|---|
| NFR-D01 | Foreign key constraints prevent orphaned records across all tables | **Implemented** |
| NFR-D02 | `ON DELETE RESTRICT` prevents deletion of users or categories that are referenced by tickets | **Implemented** |
| NFR-D03 | A ticket cannot have status `RESOLVED` or `CLOSED` without a `resolved_at` timestamp | **Implemented** |
| NFR-D04 | A ticket cannot have status `CLOSED` without a `closed_at` timestamp | **Implemented** |
| NFR-D05 | Category names are unique regardless of letter case | **Implemented** |
| NFR-D06 | User email addresses are unique regardless of letter case | **Implemented** |
| NFR-D07 | AI suggestions with status `ACCEPTED` or `REJECTED` must have a `reviewed_by` and `reviewed_at` | **Implemented** (schema only) |

### Performance

| ID | Requirement | Status |
|---|---|---|
| NFR-P01 | A `pg.Pool` is used to reuse database connections instead of opening a new connection per request | **Implemented** |
| NFR-P02 | A dedicated connection pool is used for the session store to avoid interference with the main pool | **Implemented** |
| NFR-P03 | Additional indexes on `tickets` (by customer, status, and agent) are designed and planned | **Planned** |

### Reliability and Error Handling

| ID | Requirement | Status |
|---|---|---|
| NFR-R01 | All async route handlers are wrapped in `asyncHandler` so unhandled rejections go to the global error handler | **Implemented** |
| NFR-R02 | The global error handler returns consistent `{ status, message }` JSON for all errors | **Implemented** |
| NFR-R03 | `5xx` errors are logged to the console; `4xx` errors are not | **Implemented** |
| NFR-R04 | Malformed JSON in the request body returns `400 Bad Request` with a clear message | **Implemented** |
| NFR-R05 | Graceful shutdown handles `SIGINT` and `SIGTERM` and closes the database pool before exiting | **Implemented** |

### Maintainability

| ID | Requirement | Status |
|---|---|---|
| NFR-M01 | Each module separates routes, controllers, services, and validation into distinct files | **Implemented** |
| NFR-M02 | Business logic lives in service files, not in route handlers or controllers | **Implemented** |
| NFR-M03 | ESLint is configured and enforces consistent code style | **Implemented** |

### Accessibility and Usability

| ID | Requirement | Status |
|---|---|---|
| NFR-A01 | API error responses include field-level errors where applicable (e.g., which form field failed validation) | **Implemented** |
| NFR-A02 | HTTP status codes accurately reflect the outcome of each request | **Implemented** |

### Testing

| ID | Requirement | Status |
|---|---|---|
| NFR-T01 | Integration tests cover the full authentication flow (register, login, me, logout) | **Implemented** |
| NFR-T02 | Integration tests cover the full category management flow | **Implemented** |
| NFR-T03 | Tests use Node.js built-in test runner (no external test framework required) | **Implemented** |
| NFR-T04 | Tests run against a real database, not a mock | **Implemented** |

### Privacy

| ID | Requirement | Status |
|---|---|---|
| NFR-PV01 | `password_hash` is never included in any API response | **Implemented** |
| NFR-PV02 | `is_active` is not exposed in the authenticated user profile | **Implemented** |
| NFR-PV03 | `saveUninitialized: false` on session config prevents creating sessions for unauthenticated visitors | **Implemented** |

---

## MVP vs Future Enhancements

### MVP (First Usable Version)

The MVP is complete when a customer can submit a ticket, an agent can respond and close it, an admin can manage categories and assign tickets, and basic AI classification is available.

See [01-project-overview.md § 8](./01-project-overview.md) for the full MVP feature list.

### Future Enhancements

- Email notifications on ticket creation, assignment, and resolution
- File attachment support
- Advanced search, filter, sort, and pagination on ticket lists
- Dashboard with charts and trend data
- Webhook support for external integrations
- Automated escalation when a ticket remains open for too long
- Accessibility compliance (WCAG 2.1 AA)

---

*Previous: [01 — Project Overview](./01-project-overview.md) | Next: [03 — System Architecture](./03-system-architecture.md)*

