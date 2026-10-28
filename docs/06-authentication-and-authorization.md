# 06 — Authentication and Authorization

This document explains how the application verifies who a user is (authentication) and what they are allowed to do (authorization).

---

## The Difference Between Authentication and Authorization

These two terms are often confused.

- **Authentication** answers: *Who are you?* It verifies identity — a user proves they know the correct email and password, and the server confirms it.
- **Authorization** answers: *What are you allowed to do?* It checks permissions — even if the server knows who you are, it may not allow you to access a specific resource or perform a specific action.

Both checks are enforced on the **backend**. The frontend may hide buttons or redirect unauthenticated users, but those are user-experience improvements only. A user who understands HTTP requests can bypass the frontend entirely.

---

## Authentication Flow

### 1. Registration

Implemented in [`auth.service.js`](../src/modules/auth/auth.service.js) and [`auth.routes.js`](../src/modules/auth/auth.routes.js).

1. The client sends `POST /api/v1/auth/register` with `name`, `email`, and `password`.
2. The `validate` middleware checks field types, lengths, and the email format. If any field fails, `422` is returned with a field-level error list.
3. The service normalizes the email: trims whitespace and lowercases the whole string. This ensures `Alice@Example.COM` and `alice@example.com` are treated as identical.
4. The service queries the database for an existing user with the normalized email. If one exists, `409 Conflict` is returned **before** hashing to avoid paying the bcrypt cost on a request that will be rejected.
5. The password is hashed with `bcrypt.hash(password, 12)`. A work factor of 12 means bcrypt performs 2¹² iterations of its key-derivation function, making brute-force attacks slow.
6. The user is inserted with `role = 'CUSTOMER'`. The role is controlled entirely by the database default — the client cannot set it.
7. The response returns only `id`, `name`, `email`, `role`, and `created_at`. `password_hash` is never returned.

**Why not allow clients to set their own role?**
If the API accepted a `role` field from the client, any user could register as `ADMIN` by including `"role": "ADMIN"` in the request body. The service layer ignores any role sent by the client; the database default always applies.

---

### 2. Login

Implemented in [`auth.controller.js`](../src/modules/auth/auth.controller.js) and [`auth.service.js`](../src/modules/auth/auth.service.js).

1. The client sends `POST /api/v1/auth/login` with `email` and `password`.
2. Validation checks the format. Rate limiting allows a maximum of 10 attempts per IP per 15 minutes in production to slow brute-force attacks.
3. The service queries the database for the user by normalized email. It also fetches `is_active` and `password_hash`.
4. **Timing-safe comparison:** Even if no user is found, `bcrypt.compare` is still called against a dummy hash. This prevents timing attacks where an attacker can tell whether an email exists by measuring how long the server takes to respond.
5. If the password does not match or no user was found, `401 Unauthorized` is returned with the message `"Invalid email or password."` — the same message in both cases. This prevents user enumeration (discovering whether an email is registered).
6. If the user's `is_active` is `false`, `401 Unauthorized` is returned.
7. On success, the session is **regenerated** before writing any data to it. This prevents **session fixation**: an attacker cannot pre-set a session cookie before login and then use it after authentication.
8. Only `userId` and `role` are stored in the session. The password and hash are never stored anywhere in session data.
9. The session is saved to PostgreSQL before the response is sent.
10. The `Set-Cookie: helpdesk.sid=...; HttpOnly; SameSite=Lax; Path=/` header is sent.

---

### 3. Session Cookie Settings

Configured in [`config/session.js`](../src/config/session.js).

| Setting | Value | Why |
|---|---|---|
| `name` | `helpdesk.sid` | A recognizable cookie name; not the default `connect.sid` |
| `httpOnly` | `true` | JavaScript cannot read the cookie, preventing XSS-based session theft |
| `secure` | `true` in production | Cookie is only sent over HTTPS in production; `false` in development for local HTTP |
| `sameSite` | `"lax"` | Cookie is sent on same-site requests and top-level cross-site navigation. Prevents most CSRF attacks. |
| `maxAge` | 24 hours | Session expires after 24 hours |
| `resave` | `false` | Session is not re-saved to the store on every request if it was not modified |
| `saveUninitialized` | `false` | A session is not created for unauthenticated visitors |

> [!IMPORTANT]
> `sameSite: "lax"` is appropriate when the frontend and backend share the same origin (e.g., both on `yourdomain.com`). If the frontend and backend are on different origins (e.g., `app.example.com` and `api.example.com`), change `sameSite` to `"none"` **and** ensure `secure: true` is set and HTTPS is in use. Without `secure: true`, `sameSite: "none"` is rejected by modern browsers.

---

### 4. Authentication Middleware

Implemented in [`authenticate.js`](../src/middleware/authenticate.js).

On every request to a protected route:

1. `req.session.userId` is read.
2. If it is missing, `401 Unauthorized` is returned immediately.
3. The database is queried for `SELECT id, name, email, role, is_active FROM users WHERE id = $1`.
4. If no user is found (the account was deleted after the session was created), the session is destroyed and `401` is returned.
5. If `is_active` is `false`, the session is destroyed and `401` is returned.
6. `req.user` is set to `{ id, name, email, role }`. The role comes from the database query, not from the session.

**Why query the database on every request?**
Storing the role in the session would mean that a role change (e.g., promoting a user to `AGENT`) or account deactivation would not take effect until the session expires. By loading the user from the database on each request, role and activation changes are reflected immediately.

---

### 5. Current User Endpoint

`GET /api/v1/auth/me` is protected by `authenticate`. It calls `authService.getUserById(req.user.id)` to return the user's public profile.

The profile includes `id`, `name`, `email`, `role`, and `created_at`. It does not include `password_hash` or `is_active`.

---

### 6. Logout

Implemented in [`auth.controller.js`](../src/modules/auth/auth.controller.js).

1. The client sends `POST /api/v1/auth/logout`.
2. `req.session.destroy()` removes the session from the PostgreSQL store. The session ID is invalidated immediately.
3. `res.clearCookie("helpdesk.sid", ...)` instructs the browser to delete the cookie. The cookie options (name, path, sameSite) must match the original settings.
4. `200 OK` is returned.

If the request arrives with no session at all (user was already logged out), the endpoint still returns `200 OK` without error.

---

### 7. Rate Limiting

Implemented in [`auth.routes.js`](../src/modules/auth/auth.routes.js) using `express-rate-limit`.

| Environment | Limit | Window |
|---|---|---|
| Production | 10 requests per IP | 15 minutes |
| Development/test | 1000 requests per IP | 15 minutes |

The development limit is deliberately generous so automated tests do not hit the ceiling. The production limit slows credential-stuffing attacks that try many email-and-password combinations.

If the limit is exceeded, the server returns `429 Too Many Requests` with the message `"Too many requests from this IP, please try again after 15 minutes."`.

---

## Authorization

### Role-Based Authorization Middleware

Implemented in [`authorize.js`](../src/middleware/authorize.js).

```js
// Example: require ADMIN role
router.post("/", authenticate, authorize("ADMIN"), validate(...), controller.createCategory);
```

`authorize(...roles)` is a factory that returns middleware. It checks `req.user.role` against the allowed roles. If the role is not in the list, `403 Forbidden` is returned.

`authorize()` with no arguments allows any authenticated user.

`authenticate` must always run before `authorize`.

---

### Role-Permission Matrix

The following table summarizes what each role is permitted to do. **Implemented** permissions are enforced by actual code. **Planned** permissions are designed but not yet enforced by routes.

| Action | CUSTOMER | AGENT | ADMIN | Status |
|---|---|---|---|---|
| Register | ✅ | — | — | Implemented |
| Login | ✅ | ✅ | ✅ | Implemented |
| View own profile (`/me`) | ✅ | ✅ | ✅ | Implemented |
| Logout | ✅ | ✅ | ✅ | Implemented |
| View active categories | ✅ | ✅ | ✅ | Implemented |
| View all categories (incl. inactive) | ❌ | ❌ | ✅ | Implemented |
| Create category | ❌ | ❌ | ✅ | Implemented |
| Update category | ❌ | ❌ | ✅ | Implemented |
| Deactivate/activate category | ❌ | ❌ | ✅ | Implemented |
| Create ticket | ✅ | ❌ | ✅ | Planned |
| View own tickets | ✅ | ❌ | — | Planned |
| View assigned tickets | ❌ | ✅ | — | Planned |
| View all tickets | ❌ | ❌ | ✅ | Planned |
| View ticket details (own) | ✅ | ❌ | — | Planned |
| View ticket details (assigned) | — | ✅ | — | Planned |
| Add comment (customer-visible) | ✅ | ✅ | ✅ | Planned |
| Add internal comment | ❌ | ✅ | ✅ | Planned |
| Update ticket status | ❌ | ✅ | ✅ | Planned |
| Assign ticket to agent | ❌ | ❌ | ✅ | Planned |
| View ticket history | ❌ | ✅ | ✅ | Planned |
| Request AI classification | ❌ | ✅ | ✅ | Planned |
| Review AI suggestion | ❌ | ✅ | ✅ | Planned |
| Manage users | ❌ | ❌ | ✅ | Planned |
| Change user role | ❌ | ❌ | ✅ | Planned |
| View dashboard | ❌ | ✅ | ✅ | Planned |

---

### Ticket Ownership Isolation *(Planned)*

A customer must never be able to read or modify another customer's ticket, even by guessing the ticket ID in the URL.

The planned enforcement rule is:

```
If the authenticated user's role is CUSTOMER
  AND tickets.customer_id != req.user.id
  THEN return 403 Forbidden (or 404 if ticket existence must be hidden)
```

This check must happen inside the service or controller — the route path alone does not protect the data. The frontend may not expose a link to the URL, but this does not stop a user from typing one directly into a browser or using a tool like curl.

---

## CORS Configuration

Configured in [`app.js`](../src/app.js).

| Environment | `origin` setting | `credentials` |
|---|---|---|
| Development | `http://localhost:3000`, `http://localhost:5173`, `http://127.0.0.1:5173` | `true` |
| Production | Value of `FRONTEND_ORIGIN` environment variable | `true` |

`credentials: true` is required for the browser to send the session cookie with cross-origin API requests. When using `credentials: true`, the `origin` must be an explicit value — it cannot be `"*"` (wildcard). Using a wildcard with credentials is rejected by browsers.

---

## CSRF Protection

The current configuration relies on `SameSite=Lax` cookies to prevent most CSRF attacks. `Lax` means the cookie is sent with top-level GET navigations from other sites but not with cross-site POST/PATCH/DELETE requests — which is exactly where CSRF attacks occur.

For a same-site deployment (frontend and backend on the same domain), `Lax` provides sufficient CSRF protection without needing a separate CSRF token mechanism.

> [!IMPORTANT]
> If the frontend is deployed on a different domain from the backend, change `sameSite` to `"none"` and add an explicit CSRF token mechanism (such as the double-submit cookie pattern or a synchronizer token).

---

## Security Rules Summary

> **Never trust the client's role.** The role is always loaded from the database by `authenticate.js`. Headers like `X-User-Role` or body fields named `role` are ignored.

> **Never return `password_hash`.** Every user query that returns a result must explicitly select only safe columns.

> **Regenerate the session ID on login.** This prevents session fixation, where an attacker who plants a session ID before authentication can use it to hijack the session after login.

> **Destroy the session on logout.** Clearing the cookie client-side is not enough. The server must invalidate the session in the PostgreSQL store so the old session ID is permanently unusable.

> **Frontend guards are convenience only.** Hiding a UI element does not enforce authorization. Every request must be validated by the backend.

---

*Previous: [05 — API Documentation](./05-api-documentation.md) | Next: [07 — AI Integration](./07-ai-integration.md)*

