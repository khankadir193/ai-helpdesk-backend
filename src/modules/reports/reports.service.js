import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import permissions from "../../utils/permissions.js";

/**
 * SLA resolution targets by ticket priority (hours).
 * Derived from industry-standard help-desk SLAs; no DB column required.
 */
const SLA_TARGETS_H = { URGENT: 4, HIGH: 8, MEDIUM: 24, LOW: 48 };

/**
 * The shared SLA FILTER expression used in several queries.
 * Evaluates to TRUE when a resolved ticket met its priority-based target.
 */
const SLA_MET_EXPR = `(
  (t.priority = 'URGENT' AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 4)  OR
  (t.priority = 'HIGH'   AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 8)  OR
  (t.priority = 'MEDIUM' AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 24) OR
  (t.priority = 'LOW'    AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 48)
)`;

/** Safe integer parse — returns 0 for falsy / NaN */
function toInt(val) {
  if (val == null) return 0;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Safe float parse — returns null for falsy / NaN */
function toFloat(val, digits = 2) {
  if (val == null) return null;
  const n = parseFloat(val);
  return Number.isFinite(n) ? parseFloat(n.toFixed(digits)) : null;
}

/**
 * Validate and parse the date-range query params.
 * Defaults to the last 7 days when absent.
 * Throws ApiError(400) on bad formats.
 */
function parseDateRange(query) {
  const now = new Date();

  let dateTo = now;
  let dateFrom = new Date(now);
  dateFrom.setDate(dateFrom.getDate() - 6);

  if (query.date_to) {
    const d = new Date(query.date_to);
    if (isNaN(d.getTime())) throw new ApiError(400, "date_to must be a valid ISO date.");
    dateTo = d;
  }
  if (query.date_from) {
    const d = new Date(query.date_from);
    if (isNaN(d.getTime())) throw new ApiError(400, "date_from must be a valid ISO date.");
    dateFrom = d;
  }
  if (dateFrom > dateTo) {
    throw new ApiError(400, "date_from must not be after date_to.");
  }

  dateFrom.setHours(0, 0, 0, 0);
  dateTo.setHours(23, 59, 59, 999);

  return { from: dateFrom.toISOString(), to: dateTo.toISOString() };
}

/**
 * Fetch the main KPI summary and backlog breakdown.
 */
async function getKpis(from, to, agentId) {
  const openParams = agentId != null ? [agentId] : [];
  const openWhere  = agentId != null ? "AND t.assigned_agent_id = $1" : "";

  // Backlog counts (live snapshot)
  const { rows: openRows } = await database.query(
    `SELECT
       COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE t.assigned_agent_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE t.status = 'IN_PROGRESS')::int AS in_progress
     FROM tickets t
     WHERE t.status IN ('OPEN', 'IN_PROGRESS')
     ${openWhere}`,
    openParams,
  );

  const p = [from, to];
  const agentClause = agentId != null ? `AND t.assigned_agent_id = $${p.push(agentId)}` : "";

  // Resolved tickets in period
  const { rows: resolvedRows } = await database.query(
    `SELECT COUNT(*)::int AS count
     FROM tickets t
     WHERE t.status IN ('RESOLVED', 'CLOSED')
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${agentClause}`,
    p,
  );

  // Avg resolution time in hours
  const { rows: resTimeRows } = await database.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) AS avg_hours
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${agentClause}`,
    p,
  );

  // Avg first response time in hours
  const frP = [from, to];
  const frAgentClause = agentId != null ? `AND sub.assigned_agent_id = $${frP.push(agentId)}` : "";
  const { rows: frRows } = await database.query(
    `SELECT AVG(first_resp_seconds) / 3600 AS avg_hours
     FROM (
       SELECT
         t.assigned_agent_id,
         EXTRACT(EPOCH FROM (MIN(c.created_at) - t.created_at)) AS first_resp_seconds
       FROM tickets t
       JOIN ticket_comments c ON c.ticket_id = t.id
       JOIN users u            ON u.id = c.author_id AND u.role != 'CUSTOMER'
       WHERE t.created_at >= $1 AND t.created_at <= $2
       GROUP BY t.id, t.assigned_agent_id
     ) sub
     WHERE first_resp_seconds >= 0
     ${frAgentClause}`,
    frP,
  );

  // SLA compliance in period
  const { rows: slaRows } = await database.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${SLA_MET_EXPR})::int AS within_target,
       COUNT(*)::int                                  AS total_resolved
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${agentClause}`,
    p,
  );

  const withinTarget  = toInt(slaRows[0]?.within_target);
  const totalResolved = toInt(slaRows[0]?.total_resolved);
  const slaPct = totalResolved > 0
    ? Math.round((withinTarget / totalResolved) * 100)
    : null;

  const openCount       = toInt(openRows[0]?.count);
  const unassignedCount = toInt(openRows[0]?.unassigned);
  const inProgressCount = toInt(openRows[0]?.in_progress);
  const resolvedCount   = toInt(resolvedRows[0]?.count);

  return {
    open_tickets:            openCount,
    unassigned_tickets:      unassignedCount,
    in_progress_tickets:     inProgressCount,
    resolved_tickets:        resolvedCount,
    avg_first_response_hours: toFloat(frRows[0]?.avg_hours),
    avg_resolution_hours:     toFloat(resTimeRows[0]?.avg_hours),
    sla_compliance_pct:       slaPct,
    // Customer satisfaction ratings are not stored in the schema yet.
    csat_avg:                 null,
    csat_responses:           0,
    backlog_summary: {
      open:        openCount,
      unassigned:  unassignedCount,
      in_progress: inProgressCount,
    },
  };
}

/**
 * Fetch per-day ticket volume (created & resolved) for the period.
 */
async function getTicketVolume(from, to, agentId) {
  const p = [from, to];
  const agentClause = agentId != null ? `AND t.assigned_agent_id = $${p.push(agentId)}` : "";

  const { rows } = await database.query(
    `SELECT
       d.day::date::text AS date,
       COALESCE(c.created,  0)::int AS created,
       COALESCE(r.resolved, 0)::int AS resolved
     FROM generate_series($1::timestamptz, $2::timestamptz, '1 day') AS d(day)
     LEFT JOIN (
       SELECT DATE(t.created_at) AS day, COUNT(*)::int AS created
       FROM tickets t
       WHERE t.created_at >= $1 AND t.created_at <= $2
       ${agentClause}
       GROUP BY DATE(t.created_at)
     ) c ON c.day = d.day::date
     LEFT JOIN (
       SELECT DATE(t.resolved_at) AS day, COUNT(*)::int AS resolved
       FROM tickets t
       WHERE t.resolved_at IS NOT NULL
         AND t.resolved_at >= $1 AND t.resolved_at <= $2
         ${agentClause}
       GROUP BY DATE(t.resolved_at)
     ) r ON r.day = d.day::date
     ORDER BY d.day`,
    p,
  );

  const volume = rows.map((row) => ({
    date:     row.date,
    created:  row.created,
    resolved: row.resolved,
  }));

  const totalCreated  = volume.reduce((sum, v) => sum + v.created, 0);
  const totalResolved = volume.reduce((sum, v) => sum + v.resolved, 0);

  return {
    days:           volume,
    total_created:  totalCreated,
    total_resolved: totalResolved,
  };
}

/**
 * Fetch the SLA compliance breakdown for the period.
 */
async function getSlaBreakdown(from, to, agentId) {
  const p = [from, to];
  const agentClause = agentId != null ? `AND t.assigned_agent_id = $${p.push(agentId)}` : "";

  const { rows } = await database.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${SLA_MET_EXPR})::int       AS within_target,
       COUNT(*) FILTER (WHERE NOT (${SLA_MET_EXPR}))::int AS breached_target,
       COUNT(*)::int                                        AS total_resolved
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${agentClause}`,
    p,
  );

  const withinTarget   = toInt(rows[0]?.within_target);
  const breachedTarget = toInt(rows[0]?.breached_target);
  const totalResolved  = toInt(rows[0]?.total_resolved);
  const percentage     = totalResolved > 0
    ? Math.round((withinTarget / totalResolved) * 100)
    : null;

  return {
    percentage,
    within_target:   withinTarget,
    breached_target: breachedTarget,
    total_resolved:  totalResolved,
    note: "Share resolved within the configured SLA. Open tickets are excluded.",
  };
}

/**
 * Fetch per-agent performance metrics for the period.
 */
async function getAgentPerformance(from, to, agentId) {
  const p = [from, to];
  const agentClause = agentId != null ? `AND u.id = $${p.push(agentId)}` : "";

  const { rows } = await database.query(
    `WITH ticket_first_resp AS (
       SELECT
         t.assigned_agent_id,
         GREATEST(
           EXTRACT(EPOCH FROM (MIN(c.created_at) - t.created_at)) / 3600,
           0
         ) AS first_resp_hours
       FROM tickets t
       JOIN ticket_comments c ON c.ticket_id = t.id
       JOIN users            u ON u.id = c.author_id AND u.role != 'CUSTOMER'
       WHERE t.assigned_agent_id IS NOT NULL
         AND t.created_at >= $1 AND t.created_at <= $2
       GROUP BY t.id, t.assigned_agent_id
     ),
     agent_avg_resp AS (
       SELECT assigned_agent_id, AVG(first_resp_hours) AS avg_first_resp_hours
       FROM ticket_first_resp
       GROUP BY assigned_agent_id
     )
     SELECT
       u.id::text                                                            AS agent_id,
       u.name                                                                AS agent_name,
       COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int   AS resolved,
       aar.avg_first_resp_hours,
       COUNT(t.id) FILTER (WHERE t.resolved_at IS NOT NULL AND (${SLA_MET_EXPR}))::int AS sla_met_count,
       COUNT(t.id) FILTER (WHERE t.resolved_at IS NOT NULL)::int            AS resolved_with_sla
     FROM users u
     LEFT JOIN tickets t
       ON  t.assigned_agent_id = u.id
       AND t.created_at >= $1 AND t.created_at <= $2
     LEFT JOIN agent_avg_resp aar ON aar.assigned_agent_id = u.id
     WHERE u.role = 'AGENT' AND u.is_active = TRUE
     ${agentClause}
     GROUP BY u.id, u.name, aar.avg_first_resp_hours
     HAVING COUNT(t.id) > 0
     ORDER BY COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED')) DESC NULLS LAST,
              u.name ASC`,
    p,
  );

  const { rows: totalAgentsRows } = await database.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'AGENT' AND is_active = TRUE"
  );
  const totalAgentsInDb = toInt(totalAgentsRows[0]?.count);

  const agents = rows.map((row) => {
    const resolvedWithSla = toInt(row.resolved_with_sla);
    const slaMet          = toInt(row.sla_met_count);
    return {
      agent_id:                 row.agent_id,
      agent_name:               row.agent_name,
      resolved:                 toInt(row.resolved),
      avg_first_response_hours: toFloat(row.avg_first_resp_hours),
      sla_met_pct:              resolvedWithSla > 0
        ? Math.round((slaMet / resolvedWithSla) * 100)
        : null,
      csat_avg:                 null,
    };
  });

  return {
    agents,
    total_agents: totalAgentsInDb,
    meta_text: `${agents.length} of ${totalAgentsInDb} agents`,
  };
}

/**
 * Customer satisfaction data breakdown (5 stars down to 1 star).
 * No ratings are stored in the schema, so the API reports the feature as
 * unavailable instead of returning sample scores.
 */
function getCustomerSatisfaction() {
  return {
    available: false,
    average: null,
    max_rating: 5,
    total_responses: 0,
    distribution: [],
    note: "Customer satisfaction ratings are not collected in this workspace.",
  };
}

/**
 * GET /api/v1/reports/analytics
 *
 * Governed by the configurable "Reports & analytics" permission:
 *   - 'Workspace' scope: all data; the caller may filter by agent_id.
 *   - 'Own performance' scope: restricted to the caller's own data.
 */
async function getAnalytics(user, query = {}) {
  const scope = await permissions.getReportScope(user.role);
  if (scope === "NONE") {
    throw new ApiError(403, "You do not have permission to view reports.");
  }

  const { from, to } = parseDateRange(query);

  let agentId = null;
  if (scope === "OWN") {
    agentId = Number(user.id);
  } else if (query.agent_id) {
    agentId = parseInt(query.agent_id, 10);
    if (!Number.isFinite(agentId) || agentId < 1) {
      throw new ApiError(400, "agent_id must be a positive integer.");
    }
  }

  const [kpis, ticketVolume, sla, agentPerformance] = await Promise.all([
    getKpis(from, to, agentId),
    getTicketVolume(from, to, agentId),
    getSlaBreakdown(from, to, agentId),
    getAgentPerformance(from, to, agentId),
  ]);

  return {
    period:            { from, to },
    kpis,
    ticket_volume:     ticketVolume,
    sla,
    agent_performance: agentPerformance,
    csat:              getCustomerSatisfaction(),
  };
}

export default {
  getAnalytics,
  SLA_TARGETS_H,
};
