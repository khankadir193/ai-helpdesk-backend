# 01 — Project Overview

This document explains the business problem that AI Help Desk is designed to solve, who the users are, what the application does, and what the first usable version will include.

---

## 1. Project Name and Description

**AI Help Desk** is an AI-powered support ticket management system. It allows customers to submit support requests, support agents to manage and resolve those requests, and administrators to configure the system. AI assistance helps agents understand issues and prepare responses more efficiently.

This project is built as a portfolio application to demonstrate full-stack engineering skills including REST API design, PostgreSQL database design, session-based authentication, role-based authorization, automated testing, and responsible AI integration.

---

## 2. Problem Statement

| | |
|---|---|
| **Problem** | When customers experience a problem with a product or service, they often have no organized way to report it. Emails get lost, chat messages are forgotten, and there is no record of what was discussed or resolved. |
| **Impact** | Support teams spend significant time on repeated requests, cannot track progress, and customers feel ignored because they have no visibility into whether their issue is being handled. |
| **Solution** | A centralized ticket management system where every support request is recorded, assigned, tracked, and resolved through a structured workflow with clear status changes. |
| **Outcome** | Customers can see the status of their requests. Agents can manage their workload. Administrators can monitor overall support health. AI assistance reduces the time agents spend on routine tasks. |

---

## 3. Why a Support Ticket System Is Needed

Without a structured system, support work has several practical problems:

- A customer submits a request by email. The email is missed or buried. The customer does not know whether anyone is working on it.
- A support agent receives five similar requests in the same day and has no way to group or prioritize them.
- When an agent is unavailable, their requests are invisible to everyone else.
- After an issue is resolved, there is no searchable record of what caused it or how it was fixed.

A ticket management system solves these problems by giving every request a unique record with a status, an owner, a history, and a predictable workflow from submission to resolution.

---

## 4. Target Users

The application has three user roles.

### Customer
A customer is a person who experiences a problem and needs help. They register an account, submit a support ticket describing their issue, and follow its progress through the system. Customers can only see their own tickets.

### Support Agent
A support agent is a staff member responsible for resolving tickets. They review tickets assigned to them, communicate with customers through comments, update ticket status, and use AI-generated suggestions to help draft responses. Agents cannot see tickets that belong to other customers unless those tickets are assigned to them.

### Admin
An administrator manages the system configuration. They create and maintain ticket categories, manage user accounts and roles, and have access to all tickets. Admins can monitor the overall state of the support queue.

---

## 5. The Proposed Solution

AI Help Desk provides a web application with these core capabilities:

1. **Ticket submission** — Customers describe their problem, select a category, and set a priority. The system records the request and notifies the appropriate people.
2. **Ticket management** — Agents view their assigned tickets, update status, add comments, and close resolved issues.
3. **Role-based access** — Each role sees only what it is allowed to see. Customers cannot read other customers' tickets. Agents cannot change system configuration.
4. **AI assistance** — The backend sends ticket information to an AI provider and returns suggestions (category, priority, reply draft) for agent review. Agents decide whether to use the suggestion.
5. **Audit trail** — Every status change and assignment is recorded with a timestamp and the identity of the person who made the change.

---

## 6. Main Project Goals

1. Demonstrate a complete, working full-stack application with a React frontend and a Node.js/Express backend.
2. Implement server-side session authentication that is secure by default.
3. Enforce role-based authorization on every sensitive endpoint.
4. Use PostgreSQL with parameterized queries throughout — no raw string interpolation in SQL.
5. Integrate AI features responsibly: the backend controls all AI requests, suggestions are clearly labeled, and no AI output is automatically applied without human review.
6. Write integration tests that verify both happy paths and error conditions.
7. Produce documentation that a developer can use to understand and extend the project without additional explanation.

---

## 7. Expected Benefits

### For Customers
- Every request has a unique ticket number and a visible status.
- Customers receive responses through a single consistent channel.
- Previous conversations are searchable and reviewable.

### For Support Agents
- Tickets are organized in one place with filtering by status, priority, and category.
- AI suggestions reduce the time spent drafting routine responses.
- Ticket history shows what has already been tried.

### For Administrators
- User roles and categories can be managed without developer involvement.
- The support queue is visible and measurable.
- All changes are logged, which supports accountability.

---

## 8. MVP Scope

The first usable version (Minimum Viable Product) includes:

| Feature | Status |
|---|---|
| Database schema: all six core tables | **Implemented** |
| User registration with secure password hashing | **Implemented** |
| Session-based login and logout | **Implemented** |
| Current-user endpoint (`/api/v1/auth/me`) | **Implemented** |
| Category management (create, list, update, activate/deactivate) | **Implemented** |
| Ticket creation (service layer only; route not yet wired) | **Partially implemented** |
| Ticket listing and retrieval | **Planned** |
| Ticket status and assignment updates | **Planned** |
| Ticket comments | **Planned** |
| Ticket history recording | **Planned** |
| AI suggestion (classification, reply draft, summary) | **Planned** |
| User management for admins | **Planned** |
| Dashboard summary endpoint | **Planned** |
| React frontend | **Planned** |

---

## 9. Out-of-Scope Features

The following features are intentionally excluded from the MVP and may be considered for later versions:

- Email or push notifications when ticket status changes
- File or image attachments on tickets
- In-app messaging beyond structured ticket comments
- Multi-language support
- Custom ticket fields defined by administrators
- Service-level agreement tracking and escalation rules
- Advanced analytics and reporting dashboards
- Mobile applications

---

## 10. Success Criteria for the First Version

The MVP is considered successful when:

1. A new customer can register, log in, create a ticket, and view that ticket.
2. A support agent can log in, view assigned tickets, post a comment, and change a ticket's status.
3. An administrator can log in, create a category, and view all tickets.
4. A customer cannot access another customer's ticket by changing the ticket ID in a request.
5. A customer cannot perform agent or admin actions even if they manipulate the request.
6. The AI endpoint returns a suggestion to an authorized user, and the suggestion is stored without being automatically applied.
7. All integration tests pass against the real database.
8. The application runs correctly after the setup steps in [10-deployment-and-setup.md](./10-deployment-and-setup.md).

---

## 11. Example Workflow

The following example follows a single support request from submission to resolution.

> **Step 1 — Registration**
> A customer named Maya registers at the login page. The system creates a user account with the `CUSTOMER` role. Her password is hashed and never stored in plain text.
>
> **Step 2 — Login**
> Maya logs in with her email and password. The server verifies her credentials, creates a server-side session, and sends a secure cookie to her browser. The cookie contains only a session identifier, not her password.
>
> **Step 3 — Ticket creation**
> Maya submits a ticket titled "Cannot reset my password" with a description of the problem. She selects the "Login & Account" category. The system creates a ticket with status `OPEN` and priority `MEDIUM`.
>
> **Step 4 — AI classification** *(planned)*
> The backend sends the ticket title and description to the configured AI provider. The AI suggests category "Login & Account" and priority "HIGH". The suggestion is saved as a pending `ai_suggestions` record. No category or priority is changed automatically.
>
> **Step 5 — Agent assignment** *(planned)*
> An administrator assigns the ticket to a support agent named James. The assignment is recorded in `ticket_history`. James receives visibility of the ticket.
>
> **Step 6 — Agent response** *(planned)*
> James reviews the ticket and asks the AI to draft a response. The AI draft is shown to James for review. James edits the draft and posts it as a comment. The comment is visible to Maya.
>
> **Step 7 — Resolution** *(planned)*
> Maya confirms that the issue is resolved. James changes the ticket status to `RESOLVED`. The `resolved_at` timestamp is recorded. A history entry logs the change.

---

*Next: [02 — Requirements](./02-requirements.md)*

