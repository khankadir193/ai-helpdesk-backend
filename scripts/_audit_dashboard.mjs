/**
 * Live dashboard audit: compares GET /api/v1/dashboard against independently
 * computed values from raw ticket/comment rows for every role, then checks
 * the unauthenticated and zero-data cases. Read-only apart from a temporary
 * customer that is deleted again before the script exits.
 *
 * Run from the backend folder: node scripts/_audit_dashboard.mjs
 */
import bcrypt from "bcrypt";
import app from "../src/app.js";
import database from "../src/config/database.js";

const ACCOUNTS = {
  ADMIN: ["admin@example.com", "khanAdmin@543"],
  AGENT: ["agent@example.com", "khanAgent@543"],
  CUSTOMER: ["customer@example.com", "khanCustomer@543"],
};

const round2 = (value) =>
  value === null || value === undefined
    ? null
    : Number.parseFloat(Number(value).toFixed(2));

const dayKey = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let failures = 0;
function check(label, actual, expected) {
  const ok = same(actual, expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}` +
      (ok
        ? ""
        : `\n  api:      ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`),
  );
}

const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

async function login(email, password) {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers.get("set-cookie")?.split(";")[0];
}

async function getDashboard(cookie, query = "") {
  const res = await fetch(`${baseUrl}/dashboard${query}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: res.status, body: await res.json() };
}

// ── Raw data (independent of the dashboard SQL) ──────────────────────────────
const { rows: users } = await database.query(
  "SELECT id, name, email, role, is_active FROM users",
);
const { rows: tickets } = await database.query(
  `SELECT id, customer_id, assigned_agent_id, status, priority,
          created_at, resolved_at, category_id
   FROM tickets`,
);
const { rows: firstStaffComments } = await database.query(
  `SELECT c.ticket_id, MIN(c.created_at) AS first_created_at
   FROM ticket_comments c
   JOIN users u ON u.id = c.author_id
   WHERE c.is_internal = FALSE
     AND u.role <> 'CUSTOMER'
   GROUP BY c.ticket_id`,
);
const firstCommentByTicket = new Map(
  firstStaffComments.map((row) => [String(row.ticket_id), row.first_created_at]),
);

const now = new Date();
const volumeDays = Array.from({ length: 7 }, (_, index) => {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      (6 - index) * 86400000,
  );
  return date.toISOString().slice(0, 10);
});
const volumeDaySet = new Set(volumeDays);

function ticketsForRole(role, user) {
  if (role === "CUSTOMER") {
    return tickets.filter((ticket) => String(ticket.customer_id) === String(user.id));
  }
  if (role === "AGENT") {
    return tickets.filter(
      (ticket) => String(ticket.assigned_agent_id) === String(user.id),
    );
  }
  return tickets;
}

function firstResponseHours(ticket, { clamp = false } = {}) {
  const first = firstCommentByTicket.get(String(ticket.id));
  if (!first) return null;
  let hours = (new Date(first) - new Date(ticket.created_at)) / 3600000;
  if (clamp) hours = Math.max(hours, 0);
  return hours;
}

function expectedForRole(role, user) {
  const scoped = ticketsForRole(role, user);
  const statusCounts = { OPEN: 0, IN_PROGRESS: 0, RESOLVED: 0, CLOSED: 0 };
  const priorityCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, URGENT: 0 };
  const created = Object.fromEntries(volumeDays.map((day) => [day, 0]));
  const resolved = Object.fromEntries(volumeDays.map((day) => [day, 0]));

  for (const ticket of scoped) {
    statusCounts[ticket.status] += 1;
    priorityCounts[ticket.priority] += 1;
    const createdDay = dayKey(ticket.created_at);
    if (volumeDaySet.has(createdDay)) created[createdDay] += 1;
    const resolvedDay = dayKey(ticket.resolved_at);
    if (resolvedDay && volumeDaySet.has(resolvedDay)) resolved[resolvedDay] += 1;
  }

  const resolutionSamples = scoped
    .filter((ticket) => ticket.resolved_at)
    .map(
      (ticket) =>
        (new Date(ticket.resolved_at) - new Date(ticket.created_at)) / 3600000,
    );
  const responseSamples = scoped
    .map((ticket) => firstResponseHours(ticket))
    .filter((hours) => hours !== null && hours >= 0);

  const avg = (values) =>
    values.length === 0
      ? null
      : round2(values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    role,
    total_tickets: scoped.length,
    status_counts: statusCounts,
    priority_counts: priorityCounts,
    unassigned_count: scoped.filter(
      (ticket) =>
        ["OPEN", "IN_PROGRESS"].includes(ticket.status) &&
        ticket.assigned_agent_id === null,
    ).length,
    avg_first_response_hours: avg(responseSamples),
    avg_resolution_hours: avg(resolutionSamples),
    ticket_volume: {
      days: volumeDays.map((day) => ({
        date: day,
        created: created[day],
        resolved: resolved[day],
      })),
      total_created: Object.values(created).reduce((sum, v) => sum + v, 0),
      total_resolved: Object.values(resolved).reduce((sum, v) => sum + v, 0),
    },
  };
}

// ── Per-role verification ────────────────────────────────────────────────────
for (const [role, [email, password]] of Object.entries(ACCOUNTS)) {
  console.log(`\n=== ${role} ===`);
  const user = users.find((row) => row.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    check(`${role} account exists`, false, true);
    continue;
  }

  const cookie = await login(email, password);
  const { status, body } = await getDashboard(cookie, "?limit=100");
  check(`${role} status 200`, status, 200);

  const api = body.data.dashboard;
  check(`${role} role`, api.role, role);

  const expected = expectedForRole(role, user);
  for (const key of [
    "total_tickets",
    "status_counts",
    "priority_counts",
    "unassigned_count",
    "avg_first_response_hours",
    "avg_resolution_hours",
    "ticket_volume",
  ]) {
    check(`${role} ${key}`, api[key], expected[key]);
  }

  check(
    `${role} recent tickets sorted newest first`,
    api.recent_tickets.map((ticket) => String(ticket.id)),
    ticketsForRole(role, user)
      .slice()
      .sort(
        (a, b) =>
          new Date(b.created_at) - new Date(a.created_at) ||
          Number(b.id) - Number(a.id),
      )
      .slice(0, 100)
      .map((ticket) => String(ticket.id)),
  );

  check(`${role} pagination total`, api.pagination.total_items, expected.total_tickets);
  check(
    `${role} pagination pages`,
    api.pagination.total_pages,
    Math.ceil(expected.total_tickets / 100),
  );

  if (role === "ADMIN") {
    check(
      "ADMIN category counts sum to total",
      api.category_counts.reduce((sum, row) => sum + row.count, 0),
      expected.total_tickets,
    );

    const activeAgents = users
      .filter((row) => row.role === "AGENT" && row.is_active)
      .map((agent) => {
        const assigned = tickets.filter(
          (ticket) => String(ticket.assigned_agent_id) === String(agent.id),
        );
        const count = (status) =>
          assigned.filter((ticket) => ticket.status === status).length;
        const samples = assigned
          .map((ticket) => firstResponseHours(ticket, { clamp: true }))
          .filter((hours) => hours !== null);
        return {
          agent_id: String(agent.id),
          agent_name: agent.name,
          total_assigned: assigned.length,
          open: count("OPEN"),
          in_progress: count("IN_PROGRESS"),
          resolved: count("RESOLVED"),
          closed: count("CLOSED"),
          avg_first_response_hours:
            samples.length === 0
              ? null
              : round2(samples.reduce((sum, value) => sum + value, 0) / samples.length),
        };
      })
      .sort(
        (a, b) =>
          b.total_assigned - a.total_assigned ||
          a.agent_name.localeCompare(b.agent_name),
      );

    check("ADMIN agent workload", api.agent_workload, activeAgents);
  } else {
    check(`${role} has no admin sections`, {
      category_counts: api.category_counts,
      agent_workload: api.agent_workload,
    }, { category_counts: undefined, agent_workload: undefined });
  }
}

// ── Unauthenticated access ───────────────────────────────────────────────────
console.log("\n=== UNAUTHENTICATED ===");
{
  const { status, body } = await getDashboard(null);
  check("401 without a session", status, 401);
  check("401 error envelope", body.status, "error");
}

// ── Zero-data customer (temporary, removed afterwards) ───────────────────────
console.log("\n=== ZERO-DATA CUSTOMER ===");
const tempEmail = `zero_dashboard_${Date.now()}@example.com`;
const tempPassword = "khanZero@543";
let tempUserId = null;
try {
  const { rows } = await database.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'CUSTOMER')
     RETURNING id`,
    ["Zero Dashboard", tempEmail, bcrypt.hashSync(tempPassword, 10)],
  );
  tempUserId = rows[0].id;

  const cookie = await login(tempEmail, tempPassword);
  const { status, body } = await getDashboard(cookie);
  const api = body.data.dashboard;

  check("zero-data status 200", status, 200);
  check("zero-data total", api.total_tickets, 0);
  check("zero-data statuses", api.status_counts, {
    OPEN: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 0,
  });
  check("zero-data priorities", api.priority_counts, {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
    URGENT: 0,
  });
  check("zero-data unassigned", api.unassigned_count, 0);
  check("zero-data first response", api.avg_first_response_hours, null);
  check("zero-data resolution", api.avg_resolution_hours, null);
  check("zero-data volume days", api.ticket_volume.days.length, 7);
  check("zero-data volume totals", {
    created: api.ticket_volume.total_created,
    resolved: api.ticket_volume.total_resolved,
  }, { created: 0, resolved: 0 });
  check("zero-data recent tickets", api.recent_tickets, []);
  check("zero-data pagination", api.pagination, {
    page: 1,
    limit: 20,
    total_items: 0,
    total_pages: 0,
  });
} finally {
  if (tempUserId !== null) {
    await database.query("DELETE FROM users WHERE id = $1", [tempUserId]);
    console.log("temporary zero-data customer removed");
  }
}

// ── Invalid pagination ───────────────────────────────────────────────────────
console.log("\n=== INVALID PAGINATION ===");
{
  const cookie = await login(...ACCOUNTS.CUSTOMER);
  const { status, body } = await getDashboard(cookie, "?limit=101");
  check("limit=101 returns 400", status, 400);
  check("limit=101 error envelope", body.status, "error");
}

server.close();
await database.close();

console.log(
  failures === 0
    ? "\nALL DASHBOARD AUDIT CHECKS PASSED"
    : `\n${failures} DASHBOARD AUDIT CHECK(S) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
