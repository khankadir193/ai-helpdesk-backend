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
 *
 * Response aggregates:
 *  - unassigned_count: OPEN/IN_PROGRESS tickets without an assignee
 *  - avg_first_response_hours: ticket creation -> first non-customer comment
 *  - avg_resolution_hours: ticket creation -> resolved_at (null if none)
 *  - ticket_volume: { days: 7 zero-filled UTC days, total_created,
 *    total_resolved } for the created/resolved chart
 * Every aggregate uses the same role scope as `recent_tickets`.
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
 * Convert a PostgreSQL numeric aggregate (returned as a string) into a
 * rounded JavaScript number, or null when no rows contributed to it.
 *
 * @param {unknown} value
 * @param {number} [digits=2]
 * @returns {number|null}
 */
function toFloat(value, digits = 2) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Number.parseFloat(parsed.toFixed(digits)) : null;
}

/** Number of daily buckets returned for the dashboard volume chart. */
const VOLUME_DAYS = 7;

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
 * Extend a scope clause with optional date bounds on `t.created_at`.
 * Both bounds are inclusive: startDate 00:00:00 UTC through endDate
 * 23:59:59.999 UTC (implemented as exclusive < next-day 00:00:00 UTC).
 * Returns the extended scope so callers can build parameterised queries.
 *
 * @param {{ where: string, values: any[] }} scope
 * @param {{ startDate?: string|null, endDate?: string|null }} dateRange
 * @returns {{ where: string, values: any[] }}
 */
function applyDateRange(scope, { startDate, endDate } = {}) {
  if (!startDate && !endDate) return scope;

  const extra = [];
  const clauses = [];
  let idx = scope.values.length + 1;

  if (startDate) {
    clauses.push(`t.created_at >= $${idx}::timestamptz`);
    extra.push(`${startDate}T00:00:00Z`);
    idx += 1;
  }
  if (endDate) {
    // Exclusive upper bound: advance endDate by one calendar day in UTC
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const nextDay = d.toISOString().slice(0, 10);
    clauses.push(`t.created_at < $${idx}::timestamptz`);
    extra.push(`${nextDay}T00:00:00Z`);
    idx += 1;
  }

  const dateWhere = clauses.join(" AND ");
  const baseWhere = scope.where === "TRUE" ? dateWhere : `(${scope.where}) AND ${dateWhere}`;
  return {
    where: baseWhere,
    values: [...scope.values, ...extra],
  };
}

/**
 * One grouped query per dimension + one bounded recent list — no N+1.
 * The total is derived from the status aggregate (every ticket has a
 * status), so no extra COUNT query is needed.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number, startDate?: string|null, endDate?: string|null }} options
 * @returns {Promise<object>}
 */
async function buildScopedDashboard(user, { page, limit, startDate, endDate }) {
  const baseScope = scopeFor(user);
  // Apply date range to all scoped queries (KPIs, charts, recent tickets)
  const scope = applyDateRange(baseScope, { startDate, endDate });

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

  // Unassigned count: use the base role scope (not date-filtered) so the
  // "needs work" backlog is always current regardless of the date window.
  const { rows: unassignedRows } = await database.query(
    `SELECT COUNT(*)::int AS count
     FROM tickets t
     WHERE t.status IN ('OPEN', 'IN_PROGRESS')
       AND t.assigned_agent_id IS NULL
       AND ${baseScope.where}`,
    baseScope.values,
  );

  // Resolution time — apply date filter to stay consistent with the window.
  const { rows: resolutionRows } = await database.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) AS avg_hours
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND ${scope.where}`,
    scope.values,
  );

  // First response — apply date filter.
  const { rows: responseRows } = await database.query(
    `SELECT AVG(first_resp_seconds) / 3600 AS avg_hours
     FROM (
       SELECT EXTRACT(EPOCH FROM (MIN(c.created_at) - t.created_at)) AS first_resp_seconds
       FROM tickets t
       JOIN ticket_comments c ON c.ticket_id = t.id
       JOIN users u ON u.id = c.author_id AND u.role <> 'CUSTOMER'
       WHERE ${scope.where}
         AND c.is_internal = FALSE
       GROUP BY t.id
     ) sub
     WHERE first_resp_seconds >= 0`,
    scope.values,
  );

  // Volume chart: when a custom date range is supplied, span those days;
  // otherwise fall back to the default 7-day UTC window.
  let volumeRows;
  if (startDate || endDate) {
    // Derive chart bounds from the requested date range (or today as a cap).
    const todayUTC = new Date().toISOString().slice(0, 10);
    const chartStart = startDate || todayUTC;
    const chartEnd = endDate || todayUTC;
    // Parameterised inline — no VOLUME_DAYS literal needed.
    const vIdx = scope.values.length + 1;
    ({ rows: volumeRows } = await database.query(
      `WITH days AS (
         SELECT generate_series(
           $${vIdx}::date,
           $${vIdx + 1}::date,
           interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS date,
              COALESCE(c.created, 0)::int AS created,
              COALESCE(r.resolved, 0)::int AS resolved
       FROM days d
       LEFT JOIN (
         SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::int AS created
         FROM tickets t
         WHERE ${scope.where}
         GROUP BY 1
       ) c ON c.day = d.day
       LEFT JOIN (
         SELECT (t.resolved_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::int AS resolved
         FROM tickets t
         WHERE t.resolved_at IS NOT NULL
           AND ${baseScope.where}
           AND (t.resolved_at AT TIME ZONE 'UTC')::date BETWEEN $${vIdx}::date AND $${vIdx + 1}::date
         GROUP BY 1
       ) r ON r.day = d.day
       ORDER BY d.day`,
      [...scope.values, chartStart, chartEnd],
    ));
  } else {
    ({ rows: volumeRows } = await database.query(
      `WITH bounds AS (
         SELECT ((now() AT TIME ZONE 'UTC')::date - ${VOLUME_DAYS - 1}) AS start_day,
                ((now() AT TIME ZONE 'UTC')::date + 1) AS end_day
       ),
       days AS (
         SELECT generate_series(
           ((now() AT TIME ZONE 'UTC')::date - ${VOLUME_DAYS - 1}),
           ((now() AT TIME ZONE 'UTC')::date),
           interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS date,
              COALESCE(c.created, 0)::int AS created,
              COALESCE(r.resolved, 0)::int AS resolved
       FROM days d
       LEFT JOIN (
         SELECT (t.created_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::int AS created
         FROM tickets t
         WHERE t.created_at >= (SELECT start_day::timestamp AT TIME ZONE 'UTC' FROM bounds)
           AND t.created_at <  (SELECT end_day::timestamp AT TIME ZONE 'UTC' FROM bounds)
           AND ${scope.where}
         GROUP BY 1
       ) c ON c.day = d.day
       LEFT JOIN (
         SELECT (t.resolved_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::int AS resolved
         FROM tickets t
         WHERE t.resolved_at IS NOT NULL
           AND t.resolved_at >= (SELECT start_day::timestamp AT TIME ZONE 'UTC' FROM bounds)
           AND t.resolved_at <  (SELECT end_day::timestamp AT TIME ZONE 'UTC' FROM bounds)
           AND ${scope.where}
         GROUP BY 1
       ) r ON r.day = d.day
       ORDER BY d.day`,
      scope.values,
    ));
  }

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

  const volumeDays = volumeRows.map((row) => ({
    date: row.date,
    created: row.created,
    resolved: row.resolved,
  }));

  return {
    role: user.role,
    total_tickets: total,
    status_counts,
    priority_counts,
    unassigned_count: unassignedRows[0]?.count ?? 0,
    avg_first_response_hours: toFloat(responseRows[0]?.avg_hours),
    avg_resolution_hours: toFloat(resolutionRows[0]?.avg_hours),
    ticket_volume: {
      days: volumeDays,
      total_created: volumeDays.reduce((sum, day) => sum + day.created, 0),
      total_resolved: volumeDays.reduce((sum, day) => sum + day.resolved, 0),
    },
    recent_tickets: rows.map(ticketService.serializeTicket),
    pagination: {
      page,
      limit,
      total_items: total,
      total_pages: Math.ceil(total / limit),
    },
    date_range: { startDate: startDate ?? null, endDate: endDate ?? null },
  };
}

/**
 * Admin dashboard: the scoped aggregates plus the two admin-only
 * breakdowns (category counts and agent workload, each one aggregate
 * query over a LEFT JOIN so agents/categories without tickets still
 * appear with zero counts).
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number, startDate?: string|null, endDate?: string|null }} pagination
 * @returns {Promise<object>}
 */
async function buildAdminDashboard(user, { page, limit, startDate, endDate }) {
  const dashboard = await buildScopedDashboard(user, { page, limit, startDate, endDate });

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
            COUNT(t.id) FILTER (WHERE t.status = 'CLOSED')::int AS closed,
            resp.avg_first_response_hours
     FROM users u
     LEFT JOIN tickets t ON t.assigned_agent_id = u.id
     LEFT JOIN (
       SELECT assigned_agent_id, AVG(first_resp_hours) AS avg_first_response_hours
       FROM (
         SELECT t.id, t.assigned_agent_id,
                GREATEST(
                  EXTRACT(EPOCH FROM (MIN(c.created_at) - t.created_at)) / 3600,
                  0
                ) AS first_resp_hours
         FROM tickets t
         JOIN ticket_comments c ON c.ticket_id = t.id
         JOIN users cu ON cu.id = c.author_id AND cu.role <> 'CUSTOMER'
         WHERE t.assigned_agent_id IS NOT NULL
           AND c.is_internal = FALSE
         GROUP BY t.id, t.assigned_agent_id
       ) first_responses
       GROUP BY assigned_agent_id
     ) resp ON resp.assigned_agent_id = u.id
     WHERE u.role = 'AGENT'
       AND u.is_active = TRUE
     GROUP BY u.id, u.name, resp.avg_first_response_hours
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
    avg_first_response_hours: toFloat(row.avg_first_response_hours),
  }));

  return dashboard;
}

/**
 * GET /api/v1/dashboard — dashboards for all authenticated roles. The
 * role comes from the authenticated session (never the request) and
 * decides both the aggregates and their visibility scoping.
 *
 * @param {{ id: string|number, role: string }} user
 * @param {{ page: number, limit: number, startDate?: string|null, endDate?: string|null }} pagination
 * @returns {Promise<object>}
 */
async function getDashboard(user, { page, limit, startDate, endDate }) {
  switch (user.role) {
    case "ADMIN":
      return buildAdminDashboard(user, { page, limit, startDate, endDate });
    case "AGENT":
    case "CUSTOMER":
      return buildScopedDashboard(user, { page, limit, startDate, endDate });
    default:
      throw new ApiError(403, "Forbidden. You do not have permission to perform this action.");
  }
}

export default {
  getDashboard,
};
