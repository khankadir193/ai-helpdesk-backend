# 10 — Deployment and Setup

This document explains how to run the project locally and what is needed to deploy it to a production environment.

---

## Required Software

| Software | Version | Why |
|---|---|---|
| Node.js | 20.19 or newer | Specified in `package.json` `engines` field. The project uses ES modules (`"type": "module"`). |
| npm | Bundled with Node.js | Dependency management |
| PostgreSQL | 13 or newer (recommended) | Primary database. Any recent version with `BIGINT GENERATED ALWAYS AS IDENTITY` support will work. |

Verify your installed versions:

```powershell
node --version
npm --version
psql --version
```

---

## Local Setup

### Step 1 — Clone or open the project

The backend code is in the `backend/` subdirectory of the repository.

```powershell
cd "d:\github-tests\Help Desk\backend"
```

### Step 2 — Install dependencies

```powershell
npm install
```

This installs all production and development dependencies listed in [`package.json`](../package.json).

### Step 3 — Create the environment file

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in each value. See the [Environment Variables](#environment-variables) section below.

### Step 4 — Create the PostgreSQL database

Connect to PostgreSQL and create the database:

```sql
CREATE DATABASE help_desk;
```

The default database name in `.env.example` is `help_desk`. Change it in `.env` if you prefer a different name.

### Step 5 — Run the database migration

The migration creates all six core tables.

```powershell
npm run db:migrate
```

This runs `node-pg-migrate up` against the `DATABASE_URL` in your `.env` file.

> [!WARNING]
> Two migration files exist: an older JavaScript migration (`1729522800000_create-users-table.js`) and the current SQL migration (`1792999534510_initial-schema.sql`). If the older migration was previously applied, running `db:migrate` again may attempt to apply it first and fail due to schema conflicts. If this happens, check your migration history with `node-pg-migrate` and resolve the conflict before proceeding. See [Phase 1 of the Development Roadmap](./08-development-roadmap.md) for guidance.

### Step 6 — Start the server

Development mode (auto-restarts on file changes):

```powershell
npm run dev
```

Production mode:

```powershell
npm start
```

The server starts on port `3000` by default (or the `PORT` value in `.env`).

Verify it is running:

```powershell
curl http://localhost:3000/api/v1/health
# Expected: { "status": "ok", "timestamp": "..." }
```

---

## Environment Variables

All required variables are listed in [`.env.example`](../.env.example).

| Variable | Required | Description | Example |
|---|---|---|---|
| `NODE_ENV` | Yes | Runtime environment. Controls cookie security and rate limiting. | `development` |
| `PORT` | No | HTTP port the server listens on. Defaults to `3000`. | `3000` |
| `DATABASE_URL` | Yes | PostgreSQL connection string. | `postgres://postgres:postgres@localhost:5432/help_desk` |
| `SESSION_SECRET` | Yes | Secret used to sign session cookies. Must be at least 32 characters in production. | *(generated — see below)* |
| `FRONTEND_ORIGIN` | Production only | Exact origin of the frontend for CORS. No trailing slash. | `https://app.example.com` |

**Generate a secure session secret:**

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the output and set it as `SESSION_SECRET` in `.env`.

> [!CAUTION]
> Never commit `.env` to version control. It is listed in `.gitignore`. Never include real passwords, secrets, or connection strings in code or documentation.

---

## Running Tests

```powershell
npm test
```

Tests connect to the database specified in `DATABASE_URL`. It is recommended to use a separate test database to avoid polluting development data:

```powershell
# Create a test database
psql -U postgres -c "CREATE DATABASE help_desk_test;"

# Run migrations against the test database
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/help_desk_test"; npm run db:migrate

# Run tests
$env:NODE_ENV="test"; $env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/help_desk_test"; npm test
```

Or set `DATABASE_URL` in a separate `.env.test` file and load it before running.

---

## Running the Linter

```powershell
npm run lint
```

ESLint is configured in [`eslint.config.js`](../eslint.config.js). It enforces double quotes, semicolons, no unused variables, and no undefined variables.

---

## Database Migration Commands

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply all pending migrations (up) |
| `npm run db:migrate:down` | Roll back the most recent migration (down) |

Migration files live in the [`migrations/`](../migrations/) directory in `node-pg-migrate` format.

---

## Production Considerations

### HTTPS

The application must be served over HTTPS in production. Without HTTPS:

- The `Secure` cookie flag has no effect (cookies are sent over plain HTTP).
- Session data is visible in network traffic.
- Authentication is not secure.

Use a reverse proxy (Nginx, Caddy) or a platform that provides TLS termination (Railway, Render, Fly.io).

### Secure Cookies

In production (`NODE_ENV=production`):
- `cookie.secure` is set to `true` automatically.
- `SESSION_SECRET` must be at least 32 characters.

Do not set `NODE_ENV=production` in development or tests; it will make cookies inaccessible over HTTP.

### CORS

Set `FRONTEND_ORIGIN` to the exact URL of the deployed React frontend (e.g., `https://app.example.com`). Do not include a trailing slash.

If the frontend and backend are on different domains, and `sameSite: "none"` is used for cross-origin cookies, HTTPS is mandatory.

### Session Persistence

Sessions are stored in PostgreSQL (`connect-pg-simple`). They survive server restarts automatically. The `sessions` table is created when the server first starts. No separate migration is required.

Expired sessions are pruned every 15 minutes.

### Environment Secrets

In production, set environment variables through the hosting platform's secret management system rather than a `.env` file on disk. The `.env` file approach is for local development only.

### Database Connection

Use a managed PostgreSQL instance (e.g., Supabase, Neon, Railway, Amazon RDS). Set `DATABASE_URL` to the connection string provided by the host.

The default `pg.Pool` configuration works with most hosts. For hosts that require SSL, add `?sslmode=require` to the connection string or configure the pool with `ssl: { rejectUnauthorized: false }` (verify SSL certificate requirements with your host).

### Logging

The current logging is minimal (`console.error` for 500-level errors, `console.log` for startup). For production, consider integrating a structured logger (such as `pino`) that writes JSON logs to `stdout` for capture by the hosting platform.

### Trust Proxy

If the application runs behind a reverse proxy (Nginx, Railway, Render), uncomment and configure the `trust proxy` setting in [`app.js`](../src/app.js):

```js
app.set("trust proxy", 1);
```

This ensures `req.ip` reflects the real client IP for rate limiting rather than the proxy's IP.

---

## Troubleshooting

### Server fails to start: "DATABASE_URL must be set"
Ensure `.env` exists in the `backend/` directory and contains a valid `DATABASE_URL`.

### Server fails to start: "SESSION_SECRET must be set"
Ensure `.env` contains a `SESSION_SECRET` value. Generate one with the command in the [Environment Variables](#environment-variables) section.

### Migration fails: relation already exists
The database may have been partially set up. Check which tables already exist and reconcile with the migration files. In development, you can drop the database and start fresh:
```sql
DROP DATABASE help_desk;
CREATE DATABASE help_desk;
```

### Tests fail: connection refused
The PostgreSQL server is not running, or `DATABASE_URL` in `.env` points to the wrong host/port/database.

### Cookie not sent in browser
If you are testing cross-origin (frontend on `localhost:5173`, API on `localhost:3000`), ensure:
- `credentials: true` is set in the CORS config (already configured for dev origins).
- The frontend `fetch` calls include `credentials: "include"`.

### Rate limit hit during testing
In development and test environments, the rate limit is 1000 requests per 15 minutes. If you exceed this, wait or restart the server. Verify `NODE_ENV` is not set to `"production"` during development.

---

*Previous: [09 — Testing Strategy](./09-testing-strategy.md)*

