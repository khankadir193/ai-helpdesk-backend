import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import ticketService from "../tickets/ticket.service.js";
import ticketRepository from "../tickets/ticket.repository.js";
import { TICKET_STATUSES, TICKET_PRIORITIES } from "../tickets/ticket.validation.js";

/**
 * Role-scoped dashboards over read-only aggregate queries (docs/08 —
 * Phase 7). Every number is computed server-side from PostgreSQL; no
 * user id or role ever comes from the request. The dashboard never
 * modifies ticket data.
 *
 * Status/priority breakdowns always include every existing enum value
 * (zero-filled) so the counts reconcile with the totals without the
 * consumer having to guess missing keys.
 */

/**
 * Build a map with every key of `keys` set to 0 so aggregates can be
 * spread onto it (missing buckets are legitimately zero, not absent).
 *
 * @param {string[]} keys
 * @returns {Record<string, number>}
 */
function zeroCounts(keys) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts;
}

/**
 * Map aggregate rows ({[key]: string, count: number}) onto a zeroed map.
 * Rows carrying a value outside the known enums cannot happen (DB CHECK
 * constraints), so unexpected keys are counted defensively instead of
 * being silently dropped.
 *
 * @param {Array<object>} rows
 * @param {string} keyColumn
 * @param {Record<string, number>} counts target (already zero-filled)
 * @returns {Record<string, number>}
 */
function foldCounts(rows, keyColumn, counts) {
  for (const row of rows) {
    counts[row[keyColumn]] = (counts[row[keyColumn]] ?? 0) + row.count;
  }
  return counts;
}

/**
 * The WHERE clause that scopes any tickets query to the caller's view of
 * the world (the same rules as the tickets listing service):
 *  - CUSTOMER: tickets they created
 *  - AGENT:    tickets assigned to them
 *  - ADMIN:    every ticket
 *
 * @param {{ id: string|number, role: string }} user
 * @returns {{ where: string, values: any[] }}
 */
function scopeFor(user) {
  if (user.role === "CUSTOMER") {
    return { where: "t.customer_id = $1", values: [user.id] };
  }
  if (user.role === "AGENT") {
    return { where: "t.assigned_agent_id = $1", values: [user.id] };
  }
  return { where: "TRUE", values: [] };
}

/**
 * One grouped query per dimension + one bounded recent list — no N+1.
 * The total is derived from the status aggregate (every ticket has a
 * status), so no extra COUNT query is needed.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number }} pagination
 * @returns {Promise<object>}
 */
async function buildScopedDashboard(user, { page, limit }) {
  const scope = scopeFor(user);

  const { rows: statusRows } = await database.query(
    `SELECT t.status, COUNT(*)::int AS count
     FROM tickets t
     WHERE ${scope.where}
     GROUP BY t.status`,
    scope.values,
  );
  const status_counts = foldCounts(statusRows, "status", zeroCounts(TICKET_STATUSES));
  let total = 0;
  for (const status of TICKET_STATUSES) {
    total += status_counts[status];
  }

  const { rows: priorityRows } = await database.query(
    `SELECT t.priority, COUNT(*)::int AS count
     FROM tickets t
     WHERE ${scope.where}
     GROUP BY t.priority`,
    scope.values,
  );
  const priority_counts = foldCounts(priorityRows, "priority", zeroCounts(TICKET_PRIORITIES));

  // Newest first, stable order; the same serializer and pagination model
  // as the tickets listing endpoint.
  const rows = await ticketRepository.listTickets({
    where: scope.where,
    values: scope.values,
    sort: "created_at",
    order: "DESC",
    limit,
    offset: (page - 1) * limit,
  });

  return {
    role: user.role,
    total_tickets: total,
    status_counts,
    priority_counts,
    recent_tickets: rows.map(ticketService.serializeTicket),
    pagination: {
      page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Admin dashboard: the scoped aggregates plus the two admin-only
 * breakdowns (category counts and agent workload, each one aggregate
 * query over a LEFT JOIN so agents/categories without tickets still
 * appear with zero counts).
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number }} pagination
 * @returns {Promise<object>}
 */
async function buildAdminDashboard(user, { page, limit }) {
  const dashboard = await buildScopedDashboard(user, { page, limit });

  const { rows: categoryRows } = await database.query(
    `SELECT c.id AS category_id, c.name AS category_name,
            COUNT(t.id)::int AS count
     FROM tickets t
     LEFT JOIN categories c ON c.id = t.category_id
     GROUP BY c.id, c.name
     ORDER BY count DESC, c.name ASC NULLS LAST`,
  );
  dashboard.category_counts = categoryRows.map((row) => ({
    category_id: row.category_id === null ? null : String(row.category_id),
    category_name: row.category_name,
    count: row.count,
  }));

  const { rows: workloadRows } = await database.query(
    `SELECT u.id AS agent_id, u.name AS agent_name,
            COUNT(t.id)::int AS total_assigned,
            COUNT(t.id) FILTER (WHERE t.status = 'OPEN')::int AS open,
            COUNT(t.id) FILTER (WHERE t.status = 'IN_PROGRESS')::int AS in_progress,
            COUNT(t.id) FILTER (WHERE t.status = 'RESOLVED')::int AS resolved,
            COUNT(t.id) FILTER (WHERE t.status = 'CLOSED')::int AS closed
     FROM users u
     LEFT JOIN tickets t ON t.assigned_agent_id = u.id
     WHERE u.role = 'AGENT'
     GROUP BY u.id, u.name
     ORDER BY total_assigned DESC, u.name ASC NULLS LAST`,
  );
  dashboard.agent_workload = workloadRows.map((row) => ({
    agent_id: String(row.agent_id),
    agent_name: row.agent_name,
    total_assigned: row.total_assigned,
    open: row.open,
    in_progress: row.in_progress,
    resolved: row.resolved,
    closed: row.closed,
  }));

  return dashboard;
}

/**
 * GET /api/v1/dashboard — dashboards for all authenticated roles. The
 * role comes from the authenticated session (never the request) and
 * decides both the aggregates and their visibility scoping.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number }} pagination
 * @returns {Promise<object>}
 */
async function getDashboard(user, { page, limit }) {
  switch (user.role) {
    case "ADMIN":
      return buildAdminDashboard(user, { page, limit });
    case "AGENT":
    case "CUSTOMER":
      return buildScopedDashboard(user, { page, limit });
    default:
      throw new ApiError(403, "Forbidden. You do not have permission to perform this action.");
  }
}

export default {
  getDashboard,
};
