# 05 — API Documentation

This document describes the REST API for AI Help Desk. All endpoints are prefixed with `/api/v1`.

**Implemented** endpoints have working code. **Planned** endpoints are designed but not yet implemented.

---

## HTTP Status Code Reference

| Code | Meaning | When Used |
|---|---|---|
| `200 OK` | Success | GET and POST/PATCH requests that succeed but don't create a resource |
| `201 Created` | Resource created | Successful POST that creates a new record |
| `400 Bad Request` | Malformed request | Invalid query parameters, malformed JSON body |
| `401 Unauthorized` | Not authenticated | No session, expired session, deleted/deactivated user |
| `403 Forbidden` | Authenticated but not allowed | User is logged in but their role does not permit the action |
| `404 Not Found` | Resource does not exist | Record not found, or resource hidden from the caller's role |
| `409 Conflict` | Duplicate resource | Email already registered, category name already exists |
| `422 Unprocessable Content` | Validation failed | Body fields fail type, length, or pattern rules |
| `500 Internal Server Error` | Unexpected server error | Unhandled exception; details are logged, not exposed |

---

## Standard Response Envelopes

### Success

```json
{
  "status": "success",
  "data": { ... }
}
```

### Error

```json
{
  "status": "error",
  "message": "Human-readable description"
}
```

### Validation Error (422)

```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "email must be a valid email address" },
    { "field": "password", "message": "password must be at least 8 characters" }
  ]
}
```

---

## Module: Authentication

### `POST /api/v1/auth/register` — **Implemented**

Register a new user account. New accounts always receive the `CUSTOMER` role. The role cannot be set by the client.

**Authentication required:** No  
**Rate limit:** 10 requests per 15 minutes per IP (in production)

**Request body:**

```json
{
  "name": "Maya Patel",
  "email": "maya@example.com",
  "password": "SecurePass1!"
}
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | Required. 1–100 characters. Cannot be blank. |
| `email` | string | Required. Max 254 characters. Must match basic email format. |
| `password` | string | Required. 8–72 characters. 72 is bcrypt's effective input limit. |

**Success — `201 Created`:**

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "42",
      "name": "Maya Patel",
      "email": "maya@example.com",
      "role": "CUSTOMER",
      "created_at": "2026-10-27T16:30:00.000Z"
    }
  }
}
```

> [!IMPORTANT]
> `password_hash` is never returned in any response. The role is always set by the server regardless of what the client sends.

**Error responses:**

| Status | Condition |
|---|---|
| `409 Conflict` | Email already registered (case-insensitive) |
| `422` | Missing or invalid fields (see `errors` array) |

---

### `POST /api/v1/auth/login` — **Implemented**

Authenticate a user. On success, creates a server-side session and sets the `helpdesk.sid` cookie.

**Authentication required:** No  
**Rate limit:** 10 requests per 15 minutes per IP (in production)

**Request body:**

```json
{
  "email": "maya@example.com",
  "password": "SecurePass1!"
}
```

**Success — `200 OK`:**

Sets the response header `Set-Cookie: helpdesk.sid=...; HttpOnly; SameSite=Lax; Path=/`.

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "42",
      "name": "Maya Patel",
      "email": "maya@example.com",
      "role": "CUSTOMER"
    }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `401 Unauthorized` | Wrong password, unknown email, or deactivated account. Always returns `"Invalid email or password."` for wrong credentials (prevents user enumeration). |
| `422` | Missing or invalid fields |

> [!NOTE]
> The same error message is returned for "wrong password" and "unknown email" to prevent an attacker from discovering whether an email address is registered.

---

### `GET /api/v1/auth/me` — **Implemented**

Return the authenticated user's public profile.

**Authentication required:** Yes (session cookie)  
**Required role:** Any authenticated user

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "user": {
      "id": "42",
      "name": "Maya Patel",
      "email": "maya@example.com",
      "role": "CUSTOMER",
      "created_at": "2026-10-27T16:30:00.000Z"
    }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `401 Unauthorized` | No session or expired session |

---

### `POST /api/v1/auth/logout` — **Implemented**

Destroy the server-side session and clear the session cookie.

**Authentication required:** No (safe to call without a session)

**Success — `200 OK`:**

```json
{
  "status": "success",
  "message": "Logged out successfully."
}
```

This endpoint is idempotent: calling it when not logged in still returns `200`.

---

## Module: Categories

All category endpoints require a valid session. Role-based visibility rules apply.

### `GET /api/v1/categories` — **Implemented**

List ticket categories.

**Authentication required:** Yes  
**Visibility:** Customers and agents see only active categories. Admins see all categories and may filter by `is_active`.

**Query parameters (admin only):**

| Parameter | Type | Values |
|---|---|---|
| `is_active` | string | `"true"` or `"false"`. Any other value returns `400`. |

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "categories": [
      {
        "id": "1",
        "name": "Billing & Payments",
        "description": "Payment and invoice issues",
        "is_active": true,
        "created_at": "2026-10-01T12:00:00.000Z",
        "updated_at": "2026-10-01T12:00:00.000Z"
      }
    ]
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400 Bad Request` | `is_active` query param is not `"true"` or `"false"` |
| `401 Unauthorized` | No session |

---

### `GET /api/v1/categories/:id` — **Implemented**

Retrieve a single category by ID.

**Authentication required:** Yes  
**Path parameter:** `id` — positive integer

**Visibility:** Customers and agents receive `404` for inactive categories. Admins can view any category.

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "category": {
      "id": "1",
      "name": "Billing & Payments",
      "description": "Payment and invoice issues",
      "is_active": true,
      "created_at": "2026-10-01T12:00:00.000Z",
      "updated_at": "2026-10-01T12:00:00.000Z"
    }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400 Bad Request` | `id` is not a positive integer |
| `401 Unauthorized` | No session |
| `404 Not Found` | Category does not exist, or is inactive and caller is not admin |

---

### `POST /api/v1/categories` — **Implemented**

Create a new category.

**Authentication required:** Yes  
**Required role:** `ADMIN`

**Request body:**

```json
{
  "name": "Login & Account",
  "description": "Sign-in and account access issues",
  "is_active": true
}
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | Required. 1–80 characters. Cannot be blank. Must be unique (case-insensitive). |
| `description` | string or null | Optional. Max 500 characters. |
| `is_active` | boolean | Optional. Defaults to `true`. Must be a boolean, not a string. |

Unknown fields are rejected with `422`.

**Success — `201 Created`:**

```json
{
  "status": "success",
  "data": {
    "category": {
      "id": "5",
      "name": "Login & Account",
      "description": "Sign-in and account access issues",
      "is_active": true,
      "created_at": "2026-10-27T16:30:00.000Z",
      "updated_at": "2026-10-27T16:30:00.000Z"
    }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `401 Unauthorized` | No session |
| `403 Forbidden` | Role is not `ADMIN` |
| `409 Conflict` | Category name already exists (case-insensitive) |
| `422` | Validation failure (see `errors` array) |

---

### `PATCH /api/v1/categories/:id` — **Implemented**

Update a category's name, description, or active status. At least one field must be provided.

**Authentication required:** Yes  
**Required role:** `ADMIN`  
**Path parameter:** `id` — positive integer

**Request body:** (all fields optional, at least one required)

```json
{
  "name": "Account & Login",
  "description": "Updated description",
  "is_active": false
}
```

Unknown fields are rejected. An empty body is rejected.

**Success — `200 OK`:** Returns the updated category object (same shape as create).

**Error responses:**

| Status | Condition |
|---|---|
| `401 Unauthorized` | No session |
| `403 Forbidden` | Role is not `ADMIN` |
| `404 Not Found` | Category does not exist |
| `409 Conflict` | New name already belongs to another category |
| `422` | Empty body or validation failure |

---

### `PATCH /api/v1/categories/:id/status` — **Implemented**

Activate or deactivate a category.

**Authentication required:** Yes  
**Required role:** `ADMIN`  
**Path parameter:** `id` — positive integer

**Request body:**

```json
{ "is_active": false }
```

`is_active` is required and must be a boolean.

**Success — `200 OK`:** Returns the updated category object.

**Error responses:**

| Status | Condition |
|---|---|
| `401 Unauthorized` | No session |
| `403 Forbidden` | Role is not `ADMIN` |
| `404 Not Found` | Category does not exist |
| `422` | `is_active` missing or not a boolean |

---

## Module: Tickets — **Implemented**

Ticket endpoints are implemented in `src/modules/tickets/` and mounted at `/api/v1/tickets` in `app.js`. All endpoints require a valid session. Ownership scoping is enforced in the service layer and is never derived from client input: the authenticated user comes from `authenticate`, which loads the current role from the database.

**Role scoping used by every endpoint:**

| Term | CUSTOMER | AGENT | ADMIN |
|---|---|---|---|
| Own | `customer_id = self` | `assigned_agent_id = self` (assigned tickets only) | every ticket |
| Manage | create / edit own ticket while `OPEN` | view + edit priority/category of assigned tickets; transition status of assigned tickets | everything except mutating `CLOSED` tickets |

Error codes used along the way: `400` bad id/query values, `401` no/invalid session, `403` role or ownership denial, `404` missing ticket/category/agent (and 403-by-design analogues), `409` CLOSED-state conflicts and invalid transitions, `422` body validation, `500` unexpected errors.

### `POST /api/v1/tickets`

Create a new ticket. **Required role:** `CUSTOMER` (agents/admins get `403`; the creator becomes the ticket owner automatically).

**Request body:**

```json
{
  "title": "Cannot sign in with SSO",
  "description": "The single sign-on redirect fails with error 500.",
  "category_id": 1,
  "priority": "HIGH"
}
```

| Field | Rules |
|---|---|
| `title` | Required. 1–200 characters, not blank. |
| `description` | Required, not blank (trimmed). |
| `category_id` | Optional. Positive integer referencing an **active** category. `404` unknown, `400` inactive/malformed. |
| `priority` | Optional. `LOW` \| `MEDIUM` \| `HIGH` \| `URGENT`. Defaults to `MEDIUM`. Anything else is `422`. |

Unknown fields (including `status`, `assigned_agent_id`, `customer_id`) are rejected with `422`.

**Success — `201 Created`:**

```json
{
  "status": "success",
  "data": {
    "ticket": {
      "id": "209",
      "title": "Cannot sign in with SSO",
      "description": "The single sign-on redirect fails with error 500.",
      "priority": "HIGH",
      "status": "OPEN",
      "customer_id": "42",
      "assigned_agent_id": null,
      "category_id": "1",
      "customer": { "id": "42", "name": "Maya Patel", "email": "maya@example.com" },
      "assigned_agent": null,
      "category": { "id": "1", "name": "Login & Account", "is_active": true },
      "resolved_at": null,
      "closed_at": null,
      "created_at": "2026-11-01T10:00:00.000Z",
      "updated_at": "2026-11-01T10:00:00.000Z"
    }
  }
}
```

> [!IMPORTANT]
> Every creation writes a `TICKET_CREATED` row to `ticket_history` in the same transaction.

**Error responses:** `401`, `403`, `404` (category missing), `400` (category inactive or malformed), `422`, `400` malformed JSON.

### `GET /api/v1/tickets`

List tickets, scoped by role:

- `CUSTOMER` — own tickets only
- `AGENT` — tickets assigned to them only
- `ADMIN` — all tickets

**Query parameters:**

| Parameter | Type | Rules |
|---|---|---|
| `status` | string | `OPEN` \| `IN_PROGRESS` \| `RESOLVED` \| `CLOSED`; anything else `400`. |
| `priority` | string | `LOW` \| `MEDIUM` \| `HIGH` \| `URGENT`; anything else `400`. |
| `category_id` | int | Positive integer; anything else `400`. |
| `assigned_agent_id` | int | **ADMIN only.** Agents and customers get `403`. |
| `sort` | string | `created_at` (default) or `updated_at`; anything else `400`. |
| `order` | string | `asc` or `desc` (default); anything else `400`. |
| `page` | int | Default `1`; `< 1` or non-integer `400`. |
| `limit` | int | Default `20`, max `100`; outside range `400`. |

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "tickets": [ { "...same shape as detail, minus order guarantees": true } ],
    "pagination": { "page": 1, "limit": 20, "total_items": 42, "total_pages": 3 }
  }
}
```

### `GET /api/v1/tickets/:id`

Retrieve one ticket.

**Authorization:** customers see only their own tickets (`403` otherwise), agents only assigned ones (`403`), admins everything. Unknown or malformed id → `404` / `400`.

**Success — `200 OK`:** `{ status: "success", data: { ticket } }` (shape shown under POST).

### `PATCH /api/v1/tickets/:id`

Edit details. At least one field required; an empty body is `422`.

| Caller | Allowed fields | State rules |
|---|---|---|
| CUSTOMER | `title`, `description`, `category_id`, `priority` | own ticket **and** `status = OPEN`; otherwise `403` |
| AGENT | `category_id`, `priority` | assigned tickets; `403` otherwise; `403` for `title`/`description` |
| ADMIN | all fields | any non-CLOSED ticket |

`category_id: null` clears the category; a value must reference an **active** category (`400` inactive, `404` unknown). Mutating a CLOSED ticket → `409`. Every actual change appends a row to `ticket_history` (`TITLE_CHANGED`, `DESCRIPTION_CHANGED`, `CATEGORY_CHANGED`, `PRIORITY_CHANGED`); unchanged values produce no history rows and return `200`.

Unknown fields (`status`, `assigned_agent_id`) → `422` pointing at the dedicated endpoints.

### `PATCH /api/v1/tickets/:id/status`

**Required role:** `AGENT` (assigned tickets only) or `ADMIN` (any non-closed ticket); customers get `403`.

**Request body:**

```json
{ "status": "IN_PROGRESS" }
```

**Transition matrix** (`409` on every violation, including `OPEN → OPEN`):

| From | Allowed to |
|---|---|
| `OPEN` | `IN_PROGRESS`, `RESOLVED`, `CLOSED` |
| `IN_PROGRESS` | `OPEN`, `RESOLVED`, `CLOSED` |
| `RESOLVED` | `OPEN`, `IN_PROGRESS`, `CLOSED` |
| `CLOSED` | *(terminal — always `409`)* |

Timestamps: entering `RESOLVED` sets `resolved_at`; entering `CLOSED` sets `closed_at` (and fills `resolved_at` if it was still NULL, satisfying the DB CHECK); leaving `RESOLVED`/`CLOSED` to an active status clears both. Each change writes a `STATUS_CHANGED` history row.

### `PATCH /api/v1/tickets/:id/assignment`

Assign/reassign/unassign an agent. **Required role:** `ADMIN` (`403` otherwise).

**Request body:**

```json
{ "assigned_agent_id": 12 }
```

- `{ "assigned_agent_id": null }` unassigns.
- Target must exist (`404`), have the `AGENT` role (`400` otherwise) and be active (`400` if deactivated).
- CLOSED tickets are rejected with `409`.
- Assigning the same agent is an idempotent no-op that returns `200` without a history row; real changes write `ASSIGNED` rows.

**Success — `200 OK`:** `{ status: "success", data: { ticket } }` with `assigned_agent` populated.

### `GET /api/v1/tickets/:id/history`

Audit trail, newest first. **Required role:** `AGENT` (assigned tickets) or `ADMIN`. Customers always get `403`.

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "history": [
      {
        "id": "37",
        "action": "STATUS_CHANGED",
        "field_name": "status",
        "old_value": "IN_PROGRESS",
        "new_value": "RESOLVED",
        "changed_by": { "id": "60", "name": "Agent_1793..." },
        "created_at": "2026-10-27T19:12:00.000Z"
      }
    ]
  }
}
```

*Next up (separate modules, not implemented here): users management and AI endpoints — see below.*

---

## Module: Ticket Comments — **Implemented**

Comment endpoints are implemented in `src/modules/comments/` and mounted at `/api/v1/tickets/:id/comments`. All endpoints require a valid session.

**Access scoping (same rules as ticket access):**

| Role | Can view / post comments on |
|---|---|
| CUSTOMER | own tickets only (`403` otherwise) |
| AGENT | tickets assigned to them only (`403` otherwise) |
| ADMIN | every ticket |

Internal comments (`is_internal: true`) are never returned in a customer's comment list. Posting a comment is not a ticket-state change: there is **no** status restriction (e.g., a customer may still comment on a `CLOSED` ticket).

### `GET /api/v1/tickets/:id/comments`

List the comment thread of a ticket, oldest first.

**Authentication required:** Yes  
**Path parameter:** `id` — positive integer (`400` otherwise)

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "comments": [
      {
        "id": "5",
        "ticket_id": "209",
        "author_id": "42",
        "author": { "id": "42", "name": "Maya Patel" },
        "message": "The redirect also fails on my second laptop.",
        "is_internal": false,
        "created_at": "2026-11-01T12:00:00.000Z",
        "updated_at": "2026-11-01T12:00:00.000Z"
      }
    ]
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400 Bad Request` | `id` is not a positive integer |
| `401 Unauthorized` | No session |
| `403 Forbidden` | Ticket is not accessible to the caller |
| `404 Not Found` | Ticket does not exist |

---

### `POST /api/v1/tickets/:id/comments`

Append a comment to a ticket. The author is always the authenticated user; `author_id` cannot be supplied by the client (unknown field → `422`).

**Authentication required:** Yes  
**Required role:** CUSTOMER (own ticket), AGENT (assigned ticket), or ADMIN (any ticket)

**Request body:**

```json
{
  "message": "Could you try signing in again?",
  "is_internal": false
}
```

| Field | Rules |
|---|---|
| `message` | Required. Non-blank after trimming; surrounding whitespace is trimmed before storage. |
| `is_internal` | Optional boolean. Defaults to `false`. `true` from a CUSTOMER returns `403 Forbidden` and nothing is stored. |

**Success — `201 Created`:**

```json
{
  "status": "success",
  "data": {
    "comment": {
      "id": "6",
      "ticket_id": "209",
      "author_id": "60",
      "author": { "id": "60", "name": "Agent One" },
      "message": "Could you try signing in again?",
      "is_internal": false,
      "created_at": "2026-11-01T12:05:00.000Z",
      "updated_at": "2026-11-01T12:05:00.000Z"
    }
  }
}
```

**Error responses:** `400` (bad id or malformed JSON), `401`, `403` (no access, or customer attempting an internal comment), `404` (missing ticket), `422` (body validation).

---

## Module: Users — **Planned**

### `GET /api/v1/users` — **Planned**

List users. Used by admins for assignment and role management.

**Required role:** `ADMIN`

---

### `PATCH /api/v1/users/:id/role` — **Planned**

Change a user's role.

**Required role:** `ADMIN`

---

## Module: AI

### `POST /api/v1/tickets/:id/ai/classify` — **Implemented**

Reads the ticket title/description and the current active categories from PostgreSQL, classifies the ticket with Groq, and stores the result as an `ai_suggestions` record with `PENDING` status.

**Required role:** `AGENT` (assigned tickets only) or `ADMIN`

No request body is required; all inputs (ticket content, categories, requesting user) are resolved server-side.

The ticket's category, priority, status, and assignment are **not** changed automatically — applying a suggestion is always an explicit human action.

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "suggestion": {
      "id": "9",
      "ticket_id": "12",
      "suggestion_type": "CLASSIFICATION",
      "provider": "groq",
      "model_name": "llama-3.3-70b-versatile",
      "status": "PENDING",
      "result": {
        "suggestedCategory": "Account Issues",
        "suggestedCategoryId": "2",
        "confidence": 0.92,
        "reason": "The customer is experiencing a password reset problem."
      },
      "created_at": "2026-11-02T12:00:00.000Z"
    }
  }
}
```

**Errors:** `401` unauthenticated, `403` not allowed/accessible, `404` unknown ticket, `400` invalid ticket id, `429` provider rate limited, `502` invalid provider response, `503` provider not configured / no active categories, `504` provider timeout. Invalid provider responses never store a suggestion.

---

### `POST /api/v1/tickets/:id/ai/priority` — **Implemented**

Reads the ticket title/description from PostgreSQL and asks Groq to suggest exactly one priority level (`LOW`, `MEDIUM`, `HIGH`, `URGENT`). The result is stored as an `ai_suggestions` record with `suggestion_type = 'PRIORITY'` and `PENDING` status.

**Required role:** `AGENT` (assigned tickets only) or `ADMIN`

No request body is required; all inputs (ticket content, requesting user) are resolved server-side. The request shares the AI rate-limit budget with `/ai/classify`.

The ticket's actual priority is **never** changed automatically — applying the suggestion is an explicit human action (e.g., `PATCH /api/v1/tickets/:id` with `priority`).

**Success — `200 OK`:**

```json
{
  "status": "success",
  "data": {
    "suggestion": {
      "id": "10",
      "ticket_id": "12",
      "suggestion_type": "PRIORITY",
      "provider": "groq",
      "model_name": "llama-3.3-70b-versatile",
      "status": "PENDING",
      "result": {
        "suggestedPriority": "URGENT",
        "currentPriority": "MEDIUM",
        "confidence": 0.95,
        "reason": "Multiple users are blocked from working."
      },
      "created_at": "2026-11-02T12:05:00.000Z"
    }
  }
}
```

**Errors:** `401` unauthenticated, `403` not allowed/accessible, `404` unknown ticket, `400` invalid ticket id, `422` blank ticket title/description, `429` provider rate limited, `502` invalid provider response (e.g. an unknown priority level), `503` provider not configured, `504` provider timeout. Invalid provider responses never store a suggestion.

---

### `POST /api/v1/tickets/:id/ai-reply` — **Planned**

Request a reply draft for the ticket conversation.

**Required role:** `AGENT` or `ADMIN`

---

### `POST /api/v1/tickets/:id/ai-summary` — **Planned**

Request a conversation summary.

**Required role:** `AGENT` or `ADMIN`

---

## Module: Dashboard — **Planned**

### `GET /api/v1/dashboard/summary` — **Planned**

Return aggregate ticket counts by status, open ticket age, and other support metrics.

**Required role:** `AGENT` or `ADMIN`

---

## Health Check

### `GET /api/v1/health` — **Implemented**

Check API availability. Does not require authentication and does not query the database.

**Success — `200 OK`:**

```json
{
  "status": "ok",
  "timestamp": "2026-10-27T16:30:00.000Z"
}
```

---

*Previous: [04 — Database Design](./04-database-design.md) | Next: [06 — Authentication and Authorization](./06-authentication-and-authorization.md)*

