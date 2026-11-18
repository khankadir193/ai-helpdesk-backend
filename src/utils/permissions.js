/**
 * permissions.js — Configurable role-based permission engine.
 *
 * Single source of truth for the 13 workspace permissions shown in the
 * Team → Roles & permissions matrix. Values are persisted per ROLE (one row
 * per permission) in the `team_role_permissions` table, so a change applies
 * globally to every existing and newly created user of that role — there are
 * no per-user permission overrides.
 *
 * Authorization semantics: each permission value maps to an access "level"
 * for its own scale (higher = more access). Unknown/legacy values resolve to
 * the most restrictive level (fail closed). Route middleware denies requests
 * below a required minimum level; services additionally resolve the semantic
 * scope (which tickets/reports a user may touch).
 *
 * ADMIN protection (anti-lockout): the ADMIN column cannot be changed through
 * the API (the roles matrix PATCH forces admin values back to the defaults
 * below), and the two essential admin permissions always resolve as allowed
 * for ADMIN regardless of what is stored in the database.
 */
import database from "../config/database.js";
import ApiError from "./ApiError.js";

export const ADMIN_ROLE = "ADMIN";

/** Permissions that must stay available to Admins to avoid lockout. */
export const PROTECTED_ADMIN_PERMISSIONS = [
  "edit_roles_permissions",
  "billing_security_settings",
];

/**
 * Canonical permission catalogue: the matrix rows, their display names, and
 * the default value per role. Used by the team module to render/save the
 * matrix and as the fallback when a row is missing in the database.
 */
export const DEFAULT_PERMISSIONS_CONFIG = [
  {
    id: "create_tickets",
    name: "Ticket creation",
    default_values: { ADMIN: "Not allowed", AGENT: "Not allowed", CUSTOMER: "Allowed" },
  },
  {
    id: "view_tickets",
    name: "Ticket visibility",
    default_values: { ADMIN: "All tickets", AGENT: "Assigned tickets", CUSTOMER: "Own tickets" },
  },
  {
    id: "reply_tickets",
    name: "Ticket replies",
    default_values: { ADMIN: "All tickets", AGENT: "Assigned tickets", CUSTOMER: "Own tickets" },
  },
  {
    id: "internal_notes",
    name: "Internal notes",
    default_values: { ADMIN: "Allowed", AGENT: "Allowed", CUSTOMER: "Not allowed" },
  },
  {
    id: "update_status",
    name: "Status updates",
    default_values: { ADMIN: "All tickets", AGENT: "Assigned tickets", CUSTOMER: "Not allowed" },
  },
  {
    id: "assign_reassign_tickets",
    name: "Ticket assignment",
    default_values: { ADMIN: "Allowed", AGENT: "Not allowed", CUSTOMER: "Not allowed" },
  },
  {
    id: "ticket_history",
    name: "Ticket history",
    default_values: { ADMIN: "All tickets", AGENT: "Assigned tickets", CUSTOMER: "Not allowed" },
  },
  {
    id: "ai_tools",
    name: "AI tools",
    default_values: { ADMIN: "All tickets", AGENT: "Assigned tickets", CUSTOMER: "Not allowed" },
  },
  {
    id: "publish_kb",
    name: "Knowledge Base",
    default_values: { ADMIN: "Publish & edit", AGENT: "Publish & edit", CUSTOMER: "View only" },
  },
  {
    id: "view_reports",
    name: "Reports & analytics",
    default_values: { ADMIN: "Workspace", AGENT: "Own performance", CUSTOMER: "Not allowed" },
  },
  {
    id: "invite_members",
    name: "Member management",
    default_values: { ADMIN: "Allowed", AGENT: "Not allowed", CUSTOMER: "Not allowed" },
  },
  {
    id: "edit_roles_permissions",
    name: "Roles & permissions",
    default_values: { ADMIN: "Allowed", AGENT: "View only", CUSTOMER: "Not allowed" },
  },
  {
    id: "billing_security_settings",
    name: "Workspace settings",
    default_values: { ADMIN: "Allowed", AGENT: "Not allowed", CUSTOMER: "Not allowed" },
  },
];

/** Known ids (unknown ids sent to PATCH /team/roles are rejected). */
export const PERMISSION_IDS = DEFAULT_PERMISSIONS_CONFIG.map((cfg) => cfg.id);

/**
 * The selectable value vocabulary per permission. The frontend mirrors this
 * list; the PATCH endpoint rejects values outside it so the stored matrix
 * always stays machine-interpretable.
 */
export const PERMISSION_OPTIONS = {
  create_tickets: ["Allowed", "Not allowed"],
  view_tickets: ["All tickets", "Assigned tickets", "Own tickets"],
  reply_tickets: ["All tickets", "Assigned tickets", "Own tickets"],
  internal_notes: ["Allowed", "Not allowed"],
  update_status: ["All tickets", "Assigned tickets", "Own tickets", "Not allowed"],
  assign_reassign_tickets: ["Allowed", "Not allowed"],
  ticket_history: ["All tickets", "Assigned tickets", "Own tickets", "Not allowed"],
  ai_tools: ["All tickets", "Assigned tickets", "Own tickets", "Not allowed"],
  publish_kb: ["Publish & edit", "Draft only", "View only", "Not allowed"],
  view_reports: ["Workspace", "Own performance", "Not allowed"],
  invite_members: ["Allowed", "Not allowed"],
  edit_roles_permissions: ["Allowed", "View only", "Not allowed"],
  billing_security_settings: ["Allowed", "Not allowed"],
};

/** How each permission is enforced: boolean allow/deny or a scope scale. */
const PERMISSION_KIND = {
  create_tickets: "boolean",
  view_tickets: "ticket-scope",
  reply_tickets: "ticket-scope",
  internal_notes: "boolean",
  update_status: "ticket-scope",
  assign_reassign_tickets: "boolean",
  ticket_history: "ticket-scope",
  ai_tools: "ticket-scope",
  publish_kb: "kb-scope",
  view_reports: "report-scope",
  invite_members: "boolean",
  edit_roles_permissions: "roles-scope",
  billing_security_settings: "boolean",
};

/**
 * Scope value → semantic scope. Legacy vocabulary (from the pre-fix matrix)
 * is mapped defensively so old rows fail closed instead of crashing.
 */
const TICKET_SCOPE_MAP = {
  "All tickets": "ALL",
  "Assigned tickets": "ASSIGNED",
  "Team tickets": "ASSIGNED", // legacy value
  "Own tickets": "OWN",
  "Self only": "OWN", // legacy value
};

const KB_SCOPE_MAP = {
  "Publish & edit": "FULL",
  "Allowed": "FULL", // legacy value
  "Draft only": "DRAFT",
};

const REPORT_SCOPE_MAP = {
  "Workspace": "WORKSPACE",
  "Own performance": "OWN",
  "Own team": "OWN", // legacy value
};

const ROLES_SCOPE_MAP = {
  "Allowed": "EDIT",
  "View only": "VIEW",
};

/**
 * Load the stored matrix for one role. Falls back to the canonical defaults
 * per permission when the row is missing (e.g. a newly introduced permission).
 *
 * @param {string} role — uppercase role (CUSTOMER/AGENT/ADMIN)
 * @returns {Promise<Map<string, string>>} permissionId → raw value
 */
async function loadRoleValues(role) {
  const normalizedRole = String(role || "").toUpperCase();
  const { rows } = await database.query(
    "SELECT permission_id, admin_value, agent_value, customer_value FROM team_role_permissions",
  );

  const columnKey =
    normalizedRole === "ADMIN"
      ? "admin_value"
      : normalizedRole === "AGENT"
        ? "agent_value"
        : "customer_value";

  const map = new Map();
  for (const cfg of DEFAULT_PERMISSIONS_CONFIG) {
    map.set(cfg.id, cfg.default_values[normalizedRole] ?? "Not allowed");
  }
  for (const row of rows) {
    const value = row[columnKey];
    if (value != null && map.has(row.permission_id)) {
      map.set(row.permission_id, value);
    }
  }
  return map;
}

/**
 * Resolve the effective access for a role + permission.
 *
 * @param {string} role
 * @param {string} permissionId
 * @returns {Promise<{ level: number, scope: string|null }>}
 *   level: 0 = denied, higher = more access within the permission's scale.
 *   scope: semantic value ('ALL'/'ASSIGNED'/'OWN', 'FULL'/'DRAFT',
 *   'WORKSPACE', 'EDIT'/'VIEW') or null for boolean permissions.
 */
export async function resolvePermissionAccess(role, permissionId) {
  const normalizedRole = String(role || "").toUpperCase();
  const kind = PERMISSION_KIND[permissionId];

  if (!kind) {
    throw new ApiError(500, `Unknown permission "${permissionId}".`);
  }

  // Anti-lockout: essential admin capabilities can never be lost, even if
  // the stored row was corrupted.
  if (
    normalizedRole === ADMIN_ROLE &&
    PROTECTED_ADMIN_PERMISSIONS.includes(permissionId)
  ) {
    return kind === "roles-scope"
      ? { level: 2, scope: "EDIT" }
      : { level: 1, scope: null };
  }

  const values = await loadRoleValues(normalizedRole);
  const raw = values.get(permissionId) ?? "Not allowed";

  switch (kind) {
    case "boolean":
      return { level: raw === "Allowed" ? 1 : 0, scope: null };

    case "ticket-scope": {
      const scope = TICKET_SCOPE_MAP[raw] ?? "NONE";
      return {
        level: scope === "ALL" ? 3 : scope === "ASSIGNED" ? 2 : scope === "OWN" ? 1 : 0,
        scope,
      };
    }

    case "kb-scope": {
      const scope = KB_SCOPE_MAP[raw] ?? "NONE";
      return { level: scope === "FULL" ? 2 : scope === "DRAFT" ? 1 : 0, scope };
    }

    case "report-scope": {
      const scope = REPORT_SCOPE_MAP[raw] ?? "NONE";
      return { level: scope === "WORKSPACE" ? 2 : scope === "OWN" ? 1 : 0, scope };
    }

    case "roles-scope": {
      const scope = ROLES_SCOPE_MAP[raw] ?? "NONE";
      return { level: scope === "EDIT" ? 2 : scope === "VIEW" ? 1 : 0, scope };
    }

    default:
      return { level: 0, scope: null };
  }
}

/** Boolean allow/deny check (e.g. create_tickets, invite_members). */
export async function hasPermission(role, permissionId) {
  const { level } = await resolvePermissionAccess(role, permissionId);
  return level >= 1;
}

/** Ticket scope for a permission ('ALL' | 'ASSIGNED' | 'OWN' | 'NONE'). */
export async function getTicketScope(role, permissionId) {
  const { scope } = await resolvePermissionAccess(role, permissionId);
  return scope ?? "NONE";
}

/** Knowledge Base write access ('FULL' | 'DRAFT' | 'NONE'). */
export async function getKbScope(role) {
  const { scope } = await resolvePermissionAccess(role, "publish_kb");
  return scope ?? "NONE";
}

/** Reports scope ('WORKSPACE' | 'OWN' | 'NONE'). */
export async function getReportScope(role) {
  const { scope } = await resolvePermissionAccess(role, "view_reports");
  return scope ?? "NONE";
}

/** Roles & permissions matrix access ('EDIT' | 'VIEW' | 'NONE'). */
export async function getRolesMatrixScope(role) {
  const { scope } = await resolvePermissionAccess(role, "edit_roles_permissions");
  return scope ?? "NONE";
}

/**
 * Whether a ticket row is inside the given scope for the user. Works on raw
 * repository rows (customer_id / assigned_agent_id) and serialized objects
 * (customer.id / assigned_agent.id) — BIGINT ids arrive as strings.
 *
 * @param {'ALL'|'ASSIGNED'|'OWN'|'NONE'} scope
 * @param {{ id: string|number, role: string }} user
 * @param {object} ticket
 * @returns {boolean}
 */
export function ticketInScope(scope, user, ticket) {
  if (!ticket || scope === "NONE") return false;
  if (scope === "ALL") return true;

  const customerId = String(ticket.customer_id ?? ticket.customer?.id ?? "");
  const agentId = String(
    ticket.agent_id ?? ticket.assigned_agent_id ?? ticket.assigned_agent?.id ?? "",
  );

  if (scope === "ASSIGNED") {
    return agentId !== "" && agentId === String(user.id);
  }
  if (scope === "OWN") {
    return customerId !== "" && customerId === String(user.id);
  }
  return false;
}

export default {
  ADMIN_ROLE,
  PROTECTED_ADMIN_PERMISSIONS,
  DEFAULT_PERMISSIONS_CONFIG,
  PERMISSION_IDS,
  PERMISSION_OPTIONS,
  resolvePermissionAccess,
  hasPermission,
  getTicketScope,
  getKbScope,
  getReportScope,
  getRolesMatrixScope,
  ticketInScope,
};
