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

## Module: Tickets — **Planned**

The ticket routes file exists but has no routes implemented. The ticket service has a `createTicket` function (used in tests) but no route wires it to an HTTP endpoint.

> [!WARNING]
> All ticket endpoints below are **Planned**. No HTTP endpoints exist yet.

### `POST /api/v1/tickets` — **Planned**

Create a new ticket. The authenticated user becomes the customer.

**Required role:** `CUSTOMER`

**Request body:**

```json
{
  "title": "Cannot reset my password",
  "description": "The password reset email is not arriving.",
  "category_id": 1,
  "priority": "HIGH"
}
```

| Field | Rules |
|---|---|
| `title` | Required. 1–200 characters. |
| `description` | Required. Non-blank. |
| `category_id` | Optional. Must reference an **active** category. |
| `priority` | Optional. One of `LOW`, `MEDIUM`, `HIGH`, `URGENT`. Defaults to `MEDIUM`. |

**Success:** `201 Created` with the ticket object.

---

### `GET /api/v1/tickets` — **Planned**

List tickets. Visibility depends on role:
- `CUSTOMER` — own tickets only
- `AGENT` — tickets assigned to them
- `ADMIN` — all tickets

Planned filters: `status`, `priority`, `category_id`, `assigned_agent_id`.

---

### `GET /api/v1/tickets/:id` — **Planned**

Get a single ticket with its full details.

**Authorization rule:** A customer who requests a ticket they do not own receives `403 Forbidden` or `404 Not Found`.

---

### `PATCH /api/v1/tickets/:id/status` — **Planned**

Update ticket status. Sets `resolved_at` when status becomes `RESOLVED` and `closed_at` when status becomes `CLOSED`. Records the change in `ticket_history`.

**Required role:** `AGENT` or `ADMIN`

---

### `PATCH /api/v1/tickets/:id/assignment` — **Planned**

Assign or reassign a ticket to an agent. Records the change in `ticket_history`.

**Required role:** `ADMIN`

---

### `GET /api/v1/tickets/:id/history` — **Planned**

Return the audit history for a ticket.

**Required role:** `AGENT` or `ADMIN` (customers do not see internal history entries).

---

## Module: Ticket Comments — **Planned**

### `GET /api/v1/tickets/:id/comments` — **Planned**

List all comments on a ticket. Internal comments (`is_internal: true`) are filtered out for customers.

---

### `POST /api/v1/tickets/:id/comments` — **Planned**

Add a comment to a ticket.

| Field | Rules |
|---|---|
| `message` | Required. Non-blank. |
| `is_internal` | Optional boolean. Customers may not set `true`. |

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

## Module: AI — **Planned**

### `POST /api/v1/ai/classify-ticket` — **Planned**

Send ticket content to the AI provider and receive a classification suggestion (category, priority, summary). Stores the result as an `ai_suggestions` record with `PENDING` status.

**Required role:** `AGENT` or `ADMIN`

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

