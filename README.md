# Help Desk REST API

Initial Node.js and Express API scaffold using a modular, service-based layout. Business logic and authentication flows are intentionally not implemented.

## Requirements

- Node.js 20.19 or newer
- PostgreSQL

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Update `DATABASE_URL` in `.env` to match your local PostgreSQL credentials and database. `.env` is ignored by Git.

## Run

```powershell
npm run dev
```

The server listens on `http://localhost:3000` by default. Liveness endpoint: `GET /api/v1/health`. This endpoint does not require a database connection.

## Checks

```powershell
npm test
npm run lint
```

## Database migrations

PostgreSQL is the database for this project. Create the configured database before running migrations. Migration files go in `migrations/`; use the `node-pg-migrate` format and set `DATABASE_URL` in `.env`.

```powershell
npm run db:migrate
npm run db:migrate:down
```

The scaffold does not include an application schema migration. Add one when the first persistence requirements are defined.

## API layout

Versioned routes are rooted at `/api/v1`. Module directories separate routes, controllers, services, and (where needed) repositories and validation. The authentication, authorization, and validation middleware are placeholders that reject use until configured; no protected business routes are mounted.
