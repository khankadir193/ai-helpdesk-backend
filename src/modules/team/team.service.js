/**
 * Team Service — End-to-end data processing for Team Performance,
 * Roles & Permissions, Invitations, and Member directory.
 */
import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import { sendInvitationEmail } from "../../utils/mailer.js";
import {
  DEFAULT_PERMISSIONS_CONFIG,
  PERMISSION_IDS,
  PERMISSION_OPTIONS,
  hasPermission,
} from "../../utils/permissions.js";

const SLA_MET_EXPR = `(
  (t.priority = 'URGENT' AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 4)  OR
  (t.priority = 'HIGH'   AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 8)  OR
  (t.priority = 'MEDIUM' AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 24) OR
  (t.priority = 'LOW'    AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <= 48)
)`;

function toInt(val) {
  if (val == null) return 0;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : 0;
}

function toFloat(val, digits = 2) {
  if (val == null) return null;
  const n = parseFloat(val);
  return Number.isFinite(n) ? parseFloat(n.toFixed(digits)) : null;
}

function parseDateRange(query) {
  const now = new Date();
  let dateTo = now;
  let dateFrom = new Date(now);
  dateFrom.setDate(dateFrom.getDate() - 6);

  if (query.to) {
    const d = new Date(query.to);
    if (!isNaN(d.getTime())) dateTo = d;
  }
  if (query.from) {
    const d = new Date(query.from);
    if (!isNaN(d.getTime())) dateFrom = d;
  }
  if (dateFrom > dateTo) {
    throw new ApiError(400, "from date must not be after to date.");
  }

  // Normalize to UTC day boundaries so range labels, the daily
  // generate_series buckets (::date in UTC), and every query agree
  // regardless of the Node process timezone.
  dateFrom.setUTCHours(0, 0, 0, 0);
  dateTo.setUTCHours(23, 59, 59, 999);

  return { from: dateFrom.toISOString(), to: dateTo.toISOString() };
}

/**
 * 1. Team Performance Analytics
 */
async function getTeamPerformance(user, query = {}) {
  const { from, to } = parseDateRange(query);
  const ownScope = user.role === "AGENT";

  // 1. Live Workload Counts (consistent with Dashboard)
  const workloadScope = ownScope ? "AND t.assigned_agent_id = $1" : "";
  const { rows: workloadRows } = await database.query(
    `SELECT
       COUNT(*)::int AS open_tickets,
       COUNT(*) FILTER (WHERE t.assigned_agent_id IS NULL)::int AS unassigned,
       COUNT(*) FILTER (WHERE t.status = 'IN_PROGRESS')::int AS in_progress
     FROM tickets t
     WHERE t.status IN ('OPEN', 'IN_PROGRESS')
     ${workloadScope}`,
    ownScope ? [user.id] : [],
  );

  const openTickets = toInt(workloadRows[0]?.open_tickets);
  const unassignedTickets = toInt(workloadRows[0]?.unassigned);
  const inProgressTickets = toInt(workloadRows[0]?.in_progress);

  // Every period query is scoped the same way: ADMIN sees the workspace,
  // an AGENT sees only tickets assigned to them.
  const p = [from, to];
  const scopeClause = ownScope
    ? `AND t.assigned_agent_id = $${p.push(user.id)}`
    : "";

  // 2. Resolved tickets in period
  const { rows: resolvedRows } = await database.query(
    `SELECT COUNT(*)::int AS count
     FROM tickets t
     WHERE t.status IN ('RESOLVED', 'CLOSED')
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${scopeClause}`,
    p,
  );

  // 3. Avg resolution time in hours
  const { rows: resTimeRows } = await database.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600) AS avg_hours
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${scopeClause}`,
    p,
  );

  // 4. Avg first response time in hours
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
         ${scopeClause}
       GROUP BY t.id, t.assigned_agent_id
     ) sub
     WHERE first_resp_seconds >= 0`,
    p,
  );

  // 5. SLA compliance
  const { rows: slaRows } = await database.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${SLA_MET_EXPR})::int AS within_target,
       COUNT(*)::int AS total_resolved
     FROM tickets t
     WHERE t.resolved_at IS NOT NULL
       AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${scopeClause}`,
    p,
  );

  const withinTarget = toInt(slaRows[0]?.within_target);
  const totalResolved = toInt(slaRows[0]?.total_resolved);
  const resolvedCount = toInt(resolvedRows[0]?.count);
  const slaPct = totalResolved > 0 ? Math.round((withinTarget / totalResolved) * 100) : null;

  // Active agents count
  const { rows: agentCountRows } = await database.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'AGENT' AND is_active = TRUE",
  );
  const totalActiveAgents = toInt(agentCountRows[0]?.count);

  // 6. Throughput grouped daily series
  const { rows: throughputRows } = await database.query(
    `SELECT
       d.day::date::text AS date,
       COALESCE(c.created,  0)::int AS created,
       COALESCE(r.resolved, 0)::int AS resolved
     FROM generate_series($1::timestamptz, $2::timestamptz, '1 day') AS d(day)
     LEFT JOIN (
       SELECT DATE(t.created_at) AS day, COUNT(*)::int AS created
       FROM tickets t
       WHERE t.created_at >= $1 AND t.created_at <= $2
       ${scopeClause}
       GROUP BY DATE(t.created_at)
     ) c ON c.day = d.day::date
     LEFT JOIN (
       SELECT DATE(t.resolved_at) AS day, COUNT(*)::int AS resolved
       FROM tickets t
       WHERE t.resolved_at IS NOT NULL
         AND t.resolved_at >= $1 AND t.resolved_at <= $2
       ${scopeClause}
       GROUP BY DATE(t.resolved_at)
     ) r ON r.day = d.day::date
     ORDER BY d.day`,
    p,
  );

  const throughput = throughputRows.map((r) => ({
    date: r.date,
    created: r.created,
    resolved: r.resolved,
  }));

  // 7. Per-agent performance metrics
  const { rows: agentPerfRows } = await database.query(
    `WITH ticket_first_resp AS (
       SELECT
         t.assigned_agent_id,
         GREATEST(
           EXTRACT(EPOCH FROM (MIN(c.created_at) - t.created_at)) / 3600,
           0
         ) AS first_resp_hours
       FROM tickets t
       JOIN ticket_comments c ON c.ticket_id = t.id
       JOIN users u            ON u.id = c.author_id AND u.role != 'CUSTOMER'
       WHERE t.assigned_agent_id IS NOT NULL
         AND t.created_at >= $1 AND t.created_at <= $2
       GROUP BY t.id, t.assigned_agent_id
     ),
     agent_avg_resp AS (
       SELECT assigned_agent_id, AVG(first_resp_hours) AS avg_first_resp_hours
       FROM ticket_first_resp
       GROUP BY assigned_agent_id
     ),
     agent_open AS (
       SELECT assigned_agent_id, COUNT(*)::int AS open_count
       FROM tickets
       WHERE status IN ('OPEN', 'IN_PROGRESS')
       GROUP BY assigned_agent_id
     ),
     agent_res_time AS (
       SELECT assigned_agent_id, AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) AS avg_res_hours
       FROM tickets
       WHERE resolved_at IS NOT NULL
         AND resolved_at >= $1 AND resolved_at <= $2
       GROUP BY assigned_agent_id
     )
     SELECT
       u.id::text AS agent_id,
       u.name     AS agent_name,
       COALESCE(ao.open_count, 0)::int AS open_now,
       COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED'))::int AS resolved,
       aar.avg_first_resp_hours,
       art.avg_res_hours,
       COUNT(t.id) FILTER (WHERE t.resolved_at IS NOT NULL AND (${SLA_MET_EXPR}))::int AS sla_met_count,
       COUNT(t.id) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved_with_sla
     FROM users u
     LEFT JOIN tickets t ON t.assigned_agent_id = u.id AND t.created_at >= $1 AND t.created_at <= $2
     LEFT JOIN agent_avg_resp aar ON aar.assigned_agent_id = u.id
     LEFT JOIN agent_open ao ON ao.assigned_agent_id = u.id
     LEFT JOIN agent_res_time art ON art.assigned_agent_id = u.id
     WHERE u.role = 'AGENT' AND u.is_active = TRUE
     ${ownScope ? "AND u.id = $3" : ""}
     GROUP BY u.id, u.name, ao.open_count, aar.avg_first_resp_hours, art.avg_res_hours
     HAVING COUNT(t.id) > 0
     ORDER BY COUNT(t.id) FILTER (WHERE t.status IN ('RESOLVED','CLOSED')) DESC, u.name ASC`,
    p,
  );

  const agents = agentPerfRows.map((r) => {
    const resolvedWithSla = toInt(r.resolved_with_sla);
    const slaMet = toInt(r.sla_met_count);
    return {
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      open_now: toInt(r.open_now),
      resolved: toInt(r.resolved),
      avg_first_response_hours: toFloat(r.avg_first_resp_hours),
      avg_resolution_hours: toFloat(r.avg_res_hours),
      sla_met_pct: resolvedWithSla > 0 ? Math.round((slaMet / resolvedWithSla) * 100) : null,
      csat_avg: null,
    };
  });

  // AGENT callers see a single-agent report (themselves); ADMIN callers see
  // the active-agent count for the workspace.
  const totalAgentsCount = ownScope ? 1 : totalActiveAgents;

  const kpis = {
    resolved_tickets: resolvedCount,
    avg_first_response_hours: toFloat(frRows[0]?.avg_hours),
    avg_resolution_hours: toFloat(resTimeRows[0]?.avg_hours),
    sla_compliance_pct: slaPct,
    sla_within_target: withinTarget,
    sla_total_resolved: totalResolved,
    active_agents_count: totalAgentsCount,
  };

  const workload = {
    open_tickets: openTickets,
    unassigned: unassignedTickets,
    in_progress: inProgressTickets,
  };

  return {
    period: { from, to },
    kpis,
    throughput,
    workload,
    agents,
    meta: {
      total_agents: totalAgentsCount,
      active_agents: agents.length,
      meta_text: `${agents.length} of ${totalAgentsCount} agents`,
      footnote: "SLA = resolved within the configured target. Customer satisfaction ratings are not collected in this workspace.",
    },
  };
}

/**
 * 2. Team Performance CSV Export
 */
async function exportTeamPerformanceCsv(user, query = {}) {
  const data = await getTeamPerformance(user, query);

  const headers = [
    "Agent",
    "Open now",
    "Resolved",
    "First response",
    "Resolution",
    "SLA met",
  ];

  const escapeCsv = (val) => {
    if (val == null) return "\"\"";
    const str = String(val).replace(/"/g, "\"\"");
    return `"${str}"`;
  };

  const formatHrs = (hrs) => {
    if (hrs == null) return "–";
    const totalMinutes = Math.round(hrs * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h === 0) return `${m}m`;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  };

  const rows = data.agents.map((agent) => [
    escapeCsv(agent.agent_name),
    escapeCsv(agent.open_now),
    escapeCsv(agent.resolved),
    escapeCsv(formatHrs(agent.avg_first_response_hours)),
    escapeCsv(formatHrs(agent.avg_resolution_hours)),
    escapeCsv(agent.sla_met_pct != null ? `${agent.sla_met_pct}%` : "–"),
  ]);

  return [headers.map(escapeCsv).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
}

/**
 * 3. Roles & Permissions Matrix
 *
 * Defaults live in utils/permissions.js (shared with the enforcement
 * middleware authorizePermission). Stored values (team_role_permissions)
 * always win over defaults, so every Admin account sees the same saved
 * matrix and every user of a role is affected by its values.
 */

async function getRolesAndPermissions(user) {
  const canEdit = user.role === "ADMIN";

  // Find workspace admin contact
  const { rows: adminRows } = await database.query(
    "SELECT name, email FROM users WHERE role = 'ADMIN' AND is_active = TRUE ORDER BY id ASC LIMIT 1",
  );
  const adminContact = {
    name: adminRows[0]?.name || "Alex Morgan",
    email: adminRows[0]?.email || "alex.morgan@example.com",
  };

  // Fetch matrix from DB
  const { rows: matrixRows } = await database.query(
    "SELECT permission_id, admin_value, agent_value, customer_value FROM team_role_permissions",
  );
  const matrixMap = new Map();
  for (const row of matrixRows) {
    matrixMap.set(row.permission_id, {
      ADMIN: row.admin_value,
      AGENT: row.agent_value,
      CUSTOMER: row.customer_value,
    });
  }

  const permissions = DEFAULT_PERMISSIONS_CONFIG.map((cfg) => {
    const saved = matrixMap.get(cfg.id);
    return {
      id: cfg.id,
      name: cfg.name,
      values: {
        ADMIN: saved?.ADMIN || cfg.default_values.ADMIN,
        AGENT: saved?.AGENT || cfg.default_values.AGENT,
        CUSTOMER: saved?.CUSTOMER || cfg.default_values.CUSTOMER,
      },
    };
  });

  const roles = [
    { id: "ADMIN", name: "Admin", subtitle: "Full workspace access" },
    { id: "AGENT", name: "Support Agent", subtitle: "Day-to-day support" },
    { id: "CUSTOMER", name: "Customer", subtitle: "Help seeker access" },
  ];

  return {
    can_edit: canEdit,
    current_user_role: user.role,
    admin_contact: adminContact,
    roles,
    permissions,
  };
}

/**
 * 4. Update Roles & Permissions (Admin only)
 *
 * The change is GLOBAL: values are stored per role in the database, so they
 * apply to every existing and newly created user with that role. All Admin
 * accounts share one configuration, and the enforcement middleware
 * (authorizePermission) re-resolves the matrix on every request.
 *
 * ADMIN values are locked: an Admin may configure AGENT and CUSTOMER, but
 * the ADMIN column always keeps its stored value (or the catalog default
 * when no row exists yet). Any attempt to change an ADMIN value — which
 * includes stripping essential privileges like 'Edit roles & permissions'
 * or 'Billing, security & settings' — is rejected with 422, protecting
 * against administrator lockout and privilege escalation.
 *
 * Submitted role values must be part of the permission's option vocabulary
 * (PERMISSION_OPTIONS) and ids must be part of the canonical catalogue, so
 * the stored matrix always stays machine-interpretable for the engine.
 *
 * The legacy manager_value column is preserved untouched (the MANAGER role
 * is not part of the product's three-role model).
 */
const DEFAULTS_BY_ID = new Map(
  DEFAULT_PERMISSIONS_CONFIG.map((cfg) => [cfg.id, cfg.default_values]),
);

/** User-facing messages for permissions that can never be revoked from ADMIN. */
const ADMIN_LOCK_MESSAGES = {
  billing_security_settings:
    "Cannot revoke 'Billing, security & settings' from the Admin role.",
  edit_roles_permissions:
    "Cannot revoke 'Edit roles & permissions' from the Admin role.",
};

function isValidPermissionValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function updateRolesAndPermissions(user, permissions) {
  if (user.role !== "ADMIN") {
    throw new ApiError(403, "Only Admins can change workspace permissions.");
  }

  // Reject unknown permission ids outright (fail closed).
  for (const perm of permissions) {
    if (!PERMISSION_IDS.includes(perm.id)) {
      throw new ApiError(422, `Unknown permission "${perm.id}".`);
    }
  }

  // Load stored rows once — the stored ADMIN value is authoritative and locked.
  const { rows: storedRows } = await database.query(
    "SELECT permission_id, admin_value, manager_value, agent_value, customer_value FROM team_role_permissions",
  );
  const storedMap = new Map(storedRows.map((row) => [row.permission_id, row]));

  for (const perm of permissions) {
    const stored = storedMap.get(perm.id);
    const effectiveAdmin =
      stored?.admin_value || DEFAULTS_BY_ID.get(perm.id)?.ADMIN || "Allowed";

    // Lockout protection: reject ANY change to the ADMIN column.
    if (
      isValidPermissionValue(perm.admin_value) &&
      perm.admin_value !== effectiveAdmin
    ) {
      const message =
        ADMIN_LOCK_MESSAGES[perm.id] ??
        "Admin permissions are locked and cannot be modified.";
      throw new ApiError(422, message);
    }

    // Role values must stay inside the option vocabulary of the permission.
    for (const [label, value] of [
      ["AGENT", perm.agent_value],
      ["CUSTOMER", perm.customer_value],
    ]) {
      const options = PERMISSION_OPTIONS[perm.id] || [];
      if (isValidPermissionValue(value) && !options.includes(value)) {
        throw new ApiError(
          422,
          `Invalid value "${value}" for permission "${perm.id}" (${label}).`,
        );
      }
    }
  }

  // Upsert into team_role_permissions
  for (const perm of permissions) {
    const stored = storedMap.get(perm.id);
    const adminValue =
      stored?.admin_value || DEFAULTS_BY_ID.get(perm.id)?.ADMIN || "Allowed";
    // Missing role values keep their stored value, then the catalog default,
    // so a partial payload can never wipe an existing configuration.
    const agentValue = isValidPermissionValue(perm.agent_value)
      ? perm.agent_value
      : stored?.agent_value ||
        DEFAULTS_BY_ID.get(perm.id)?.AGENT ||
        "Not allowed";
    const customerValue = isValidPermissionValue(perm.customer_value)
      ? perm.customer_value
      : stored?.customer_value ||
        DEFAULTS_BY_ID.get(perm.id)?.CUSTOMER ||
        "Not allowed";
    // Legacy column: keep whatever is stored; neutral default for new rows.
    const managerValue = stored?.manager_value || "Not allowed";

    await database.query(
      `INSERT INTO team_role_permissions
         (permission_id, admin_value, manager_value, agent_value, customer_value, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (permission_id) DO UPDATE SET
         admin_value = EXCLUDED.admin_value,
         agent_value = EXCLUDED.agent_value,
         customer_value = EXCLUDED.customer_value,
         updated_at = now()`,
      [perm.id, adminValue, managerValue, agentValue, customerValue],
    );
  }

  return getRolesAndPermissions(user);
}

/**
 * 5. Request Access Change (non-admin)
 */
async function requestAccessChange(user, { reason, requested_role }) {
  await database.query(
    `INSERT INTO team_access_requests (user_id, requested_role, reason)
     VALUES ($1, $2, $3)`,
    [user.id, requested_role, reason],
  );

  return {
    message: "Access change request sent to workspace Admins.",
  };
}

/**
 * 6. Get Teams
 */
async function getTeams() {
  await database.query(
    "SELECT default_team FROM team_settings LIMIT 1",
  );
  return [
    "General support",
    "Customer Support",
    "Technical Support",
    "Billing & Account",
    "VIP Triage",
  ];
}

/**
 * 7. Get Invite Options
 *
 * Member management is a configurable permission (matrix: invite_members).
 * Admins always qualify (their ADMIN value is locked to an allowed value);
 * other roles qualify only when an Admin has granted them the permission.
 * Granted non-admin inviters may only invite SUPPORT AGENTs — inviting an
 * Admin is reserved for Admins (privilege-escalation guard).
 */
async function canInviteMembers(user) {
  return hasPermission(user.role, "invite_members");
}

async function getInviteOptions(user) {
  if (!(await canInviteMembers(user))) {
    throw new ApiError(403, "You do not have permission to invite workspace members.");
  }

  const isAdmin = user.role === "ADMIN";
  const assignableRoles = isAdmin ? ["AGENT", "ADMIN"] : ["AGENT"];

  const roles = [
    {
      id: "AGENT",
      name: "Support Agent",
      title: "Support Agent",
      description: "Work on assigned tickets and draft knowledge articles.",
      admin_only: false,
    },
    {
      id: "ADMIN",
      name: "Admin",
      title: "Admin",
      description: "Full access, including billing and workspace security.",
      admin_only: true,
    },
  ].filter((role) => isAdmin || role.id !== "ADMIN");

  return {
    assignable_roles: assignableRoles,
    roles,
    expiry_days: 7,
  };
}

/**
 * 8. Create Invitation
 */
async function createInvitation(user, { email, role, team }) {
  if (!(await canInviteMembers(user))) {
    throw new ApiError(403, "You do not have permission to invite workspace members.");
  }

  // Privilege-escalation guard: only Admins may invite Admins.
  const isAdmin = user.role === "ADMIN";
  if (!isAdmin && role !== "AGENT") {
    throw new ApiError(403, "Only Admins can invite workspace Admins.");
  }

  // Pre-check 1: Is user already a member?
  const { rows: existingUser } = await database.query(
    "SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)",
    [email],
  );
  if (existingUser.length > 0) {
    throw new ApiError(409, "A member with this email address already belongs to the workspace.");
  }

  // Pre-check 2: Is there already an active pending invitation?
  const { rows: existingInvite } = await database.query(
    `SELECT 1 FROM team_invitations
     WHERE LOWER(email) = LOWER($1) AND status = 'PENDING' AND expires_at > now()`,
    [email],
  );
  if (existingInvite.length > 0) {
    throw new ApiError(409, "An active invitation has already been sent to this work email address.");
  }

  const token = `tok_inv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const { rows: inserted } = await database.query(
    `INSERT INTO team_invitations (email, role, team, invited_by, status, token, expires_at)
     VALUES ($1, $2, $3, $4, 'PENDING', $5, now() + interval '7 days')
     RETURNING id::text, email, role, team, status, token, expires_at, created_at`,
    [email, role, team, user.id, token],
  );

  // Update pending_invites_count in team_settings
  await database.query(`
    UPDATE team_settings
    SET pending_invites_count = (
      SELECT COUNT(*)::int FROM team_invitations WHERE status = 'PENDING' AND expires_at > now()
    )
  `);

  // Send the invitation email and report the REAL delivery outcome.
  // Awaited on purpose — the API response must never claim "sent" for an
  // email that failed (see email_delivery below).
  const { token: inviteToken, ...invitation } = inserted[0];
  const email_delivery = await sendInvitationEmail({
    to: invitation.email,
    role: invitation.role,
    team: invitation.team,
    token: inviteToken,
    expiresAt: invitation.expires_at,
  });

  return { ...invitation, email_delivery };
}

/**
 * 9. List Members & Pending Invitations
 *
 * Members are paginated (page/pageSize, max 100) and optionally filtered by
 * a search term (q) matching name, email, or role. Pending invitations are
 * returned in full (they are naturally few). The response keeps the original
 * fields (members, invitations, meta) and adds KB-style pagination fields
 * (total, page, pageSize, totalPages).
 */
async function listMembers(_user, query = {}) {
  const pageNum = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.pageSize, 10) || 10));

  const trimmedSearch = typeof query.q === "string" ? query.q.trim() : "";
  const memberParams = [];
  let memberWhere = "WHERE u.role IN ('ADMIN', 'AGENT') AND u.is_active = TRUE";
  if (trimmedSearch) {
    memberParams.push(`%${trimmedSearch}%`);
    memberWhere += " AND (u.name ILIKE $1 OR u.email ILIKE $1 OR u.role ILIKE $1)";
  }

  // Total count uses exactly the same filters as the list query below.
  const { rows: countRows } = await database.query(
    `SELECT COUNT(*)::int AS total FROM users u ${memberWhere}`,
    memberParams,
  );
  const total = countRows[0]?.total || 0;
  const totalPages = Math.ceil(total / limit) || 1;

  // Gracefully clamp out-of-range pages to the last available page.
  const page = Math.min(pageNum, totalPages);
  const offset = (page - 1) * limit;

  // Query active team members (ADMIN, AGENT) for the requested page
  const { rows: memberRows } = await database.query(
    `SELECT
       u.id::text,
       u.name,
       u.email,
       u.role,
       u.is_active,
       u.created_at,
       COALESCE(up.job_title,
         CASE
           WHEN u.role = 'ADMIN' THEN 'Support Director'
           ELSE 'Customer Support Specialist'
         END
       ) AS job_title
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${memberWhere}
     ORDER BY
       CASE u.role WHEN 'ADMIN' THEN 1 ELSE 2 END,
       lower(u.name) ASC,
       u.id ASC
     LIMIT $${memberParams.length + 1} OFFSET $${memberParams.length + 2}`,
    [...memberParams, limit, offset],
  );

  // Query active pending invitations
  const { rows: inviteRows } = await database.query(
    `SELECT
       ti.id::text,
       ti.email,
       ti.role,
       ti.team,
       ti.status,
       ti.expires_at,
       ti.created_at,
       u.name AS invited_by_name
     FROM team_invitations ti
     LEFT JOIN users u ON u.id = ti.invited_by
     WHERE ti.status = 'PENDING' AND ti.expires_at > now()
     ORDER BY ti.created_at DESC`,
  );

  return {
    members: memberRows,
    invitations: inviteRows,
    total,
    page,
    pageSize: limit,
    totalPages,
    meta: {
      total_members: total,
      pending_invitations: inviteRows.length,
    },
  };
}

/**
 * Invitation ids are BIGINT identity values. Reject anything non-numeric
 * with a clear 404 instead of a Postgres cast error (500).
 */
const INVITATION_NOT_FOUND_MESSAGE =
  "Invitation not found or is no longer pending (it may already have been revoked, accepted, or expired).";

function isNumericId(value) {
  return /^[1-9]\d*$/.test(String(value ?? ""));
}

/**
 * 10. Resend Invitation
 *
 * Extends the expiry AND actually re-sends the invitation email,
 * reporting the real delivery outcome.
 */
async function resendInvitation(user, invitationId) {
  if (!(await canInviteMembers(user))) {
    throw new ApiError(403, "You do not have permission to manage invitations.");
  }

  if (!isNumericId(invitationId)) {
    throw new ApiError(404, INVITATION_NOT_FOUND_MESSAGE);
  }

  const { rows } = await database.query(
    `UPDATE team_invitations
     SET expires_at = now() + interval '7 days', updated_at = now()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING id::text, email, role, team, status, token, expires_at`,
    [invitationId],
  );

  if (rows.length === 0) {
    throw new ApiError(404, INVITATION_NOT_FOUND_MESSAGE);
  }

  const { token, ...invitation } = rows[0];
  const email_delivery = await sendInvitationEmail({
    to: invitation.email,
    role: invitation.role,
    team: invitation.team,
    token,
    expiresAt: invitation.expires_at,
  });

  return { ...invitation, email_delivery };
}

/**
 * 11. Revoke Invitation
 */
async function revokeInvitation(user, invitationId) {
  if (!(await canInviteMembers(user))) {
    throw new ApiError(403, "You do not have permission to manage invitations.");
  }

  if (!isNumericId(invitationId)) {
    throw new ApiError(404, INVITATION_NOT_FOUND_MESSAGE);
  }

  const { rows } = await database.query(
    `UPDATE team_invitations
     SET status = 'REVOKED', updated_at = now()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING id::text, email`,
    [invitationId],
  );

  if (rows.length === 0) {
    throw new ApiError(404, INVITATION_NOT_FOUND_MESSAGE);
  }

  // Update pending_invites_count
  await database.query(`
    UPDATE team_settings
    SET pending_invites_count = (
      SELECT COUNT(*)::int FROM team_invitations WHERE status = 'PENDING' AND expires_at > now()
    )
  `);

  return { id: rows[0].id, revoked: true };
}

export default {
  getTeamPerformance,
  exportTeamPerformanceCsv,
  getRolesAndPermissions,
  updateRolesAndPermissions,
  requestAccessChange,
  getTeams,
  getInviteOptions,
  createInvitation,
  listMembers,
  resendInvitation,
  revokeInvitation,
};
