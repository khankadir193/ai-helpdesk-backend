# AI Help Desk — Documentation Index

This folder contains the complete documentation for the **AI Help Desk** project: an AI-powered support ticket management system built as a full-stack portfolio project.

---

## What This Documentation Covers

The documents here explain:

- **Why** the project exists and what problem it solves
- **What** the application must do, organized by user role
- **How** the system is designed and structured
- **How** the database is organized
- **How** the REST API works
- **How** authentication and authorization are implemented
- **How** AI assistance fits into the support workflow
- **When** each feature will be built
- **How** the system is tested
- **How** to run and deploy the project

---

## Documentation Files

| File | Title | Summary |
|---|---|---|
| [01-project-overview.md](./01-project-overview.md) | Project Overview | Business problem, users, goals, and MVP scope |
| [02-requirements.md](./02-requirements.md) | Requirements | Functional and non-functional requirements by role |
| [03-system-architecture.md](./03-system-architecture.md) | System Architecture | Components, request flow, and folder structure |
| [04-database-design.md](./04-database-design.md) | Database Design | Tables, columns, relationships, and ER diagram |
| [05-api-documentation.md](./05-api-documentation.md) | API Documentation | All endpoints, request/response contracts |
| [06-authentication-and-authorization.md](./06-authentication-and-authorization.md) | Auth & Authorization | Sessions, cookies, roles, and access control |
| [07-ai-integration.md](./07-ai-integration.md) | AI Integration | AI features, request flow, and safety rules |
| [08-development-roadmap.md](./08-development-roadmap.md) | Development Roadmap | Phased implementation plan |
| [09-testing-strategy.md](./09-testing-strategy.md) | Testing Strategy | Test types, scenarios, and coverage guidance |
| [10-deployment-and-setup.md](./10-deployment-and-setup.md) | Deployment & Setup | Local setup, environment variables, and production |

---

## Recommended Reading Order

If you are new to this project, read in this order:

1. **[01-project-overview.md](./01-project-overview.md)** — Understand the business problem and what the application does before looking at any code.
2. **[02-requirements.md](./02-requirements.md)** — Learn what each user role can and cannot do.
3. **[03-system-architecture.md](./03-system-architecture.md)** — Understand how the components fit together.
4. **[04-database-design.md](./04-database-design.md)** — See how data is structured and related.
5. **[06-authentication-and-authorization.md](./06-authentication-and-authorization.md)** — Understand session-based login and role permissions.
6. **[05-api-documentation.md](./05-api-documentation.md)** — Reference the API endpoints.
7. **[10-deployment-and-setup.md](./10-deployment-and-setup.md)** — Get the project running locally.
8. The remaining files as needed.

---

## How to Distinguish Implemented from Planned Functionality

Every document uses a consistent set of labels:

| Label | Meaning |
|---|---|
| **Implemented** | The code exists and the feature works |
| **Partially implemented** | Some code exists but the feature is incomplete |
| **Planned** | Designed and documented but not yet coded |
| **Not yet implemented** | Exists as an empty file or stub only |
| **Needs verification** | Cannot be confirmed without running the project |

When in doubt, check the source file referenced in the relevant document. Do not assume a feature is complete simply because it is documented.

---

> [!NOTE]
> The frontend directory currently exists but contains no files. All documentation in this set focuses on the **backend** (`/backend`). Frontend documentation will be added when the React application is developed.

