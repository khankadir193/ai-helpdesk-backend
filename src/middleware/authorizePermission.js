/**
 * authorizePermission — permission-matrix authorization middleware.
 *
 * Complements `authorize(...roles)`: instead of a fixed role list, access is
 * decided by the persisted role permission matrix (`team_role_permissions`),
 * so changes made in Team → Roles & permissions take effect on every API
 * request for every user of the role — with no per-user exceptions.
 *
 * Usage:
 *   authorizePermission("create_tickets")              // any access (level >= 1)
 *   authorizePermission("update_status")               // scope must not be NONE
 *   authorizePermission("publish_kb", "DRAFT")         // minimum scope level
 *   authorizePermission("edit_roles_permissions", "VIEW")
 *
 * `minLevel` accepts either a numeric level or a named scope ('NONE', 'OWN',
 * 'DRAFT', 'VIEW', 'ASSIGNED', 'FULL', 'WORKSPACE', 'EDIT', 'ALL'). Unknown
 * values fail closed (the middleware denies every request).
 *
 * A request is denied with 403 unless the caller's role resolves an access
 * level >= `minLevel` for the permission. Unknown values fail closed.
 */
import ApiError from "../utils/ApiError.js";
import { resolvePermissionAccess } from "../utils/permissions.js";

/**
 * Named scope → minimum numeric level. Union of every permission scale in
 * utils/permissions.js (ticket/kb/report/roles scopes share the names).
 */
const SCOPE_LEVELS = {
  NONE: 0,
  OWN: 1,
  DRAFT: 1,
  VIEW: 1,
  ASSIGNED: 2,
  FULL: 2,
  WORKSPACE: 2,
  EDIT: 2,
  ALL: 3,
};

function normalizeMinLevel(minLevel) {
  if (typeof minLevel === "number" && Number.isFinite(minLevel)) {
    return minLevel;
  }
  if (typeof minLevel === "string") {
    const named = SCOPE_LEVELS[String(minLevel).toUpperCase()];
    if (named != null) return named;
  }
  // Fail closed: an unusable minimum denies every request.
  return Number.POSITIVE_INFINITY;
}

function authorizePermission(permissionId, minLevel = 1) {
  const min = normalizeMinLevel(minLevel);
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        return next(new ApiError(401, "Authentication required. Please log in."));
      }

      const { level } = await resolvePermissionAccess(req.user.role, permissionId);

      if (level < min) {
        return next(
          new ApiError(
            403,
            "Forbidden. You do not have permission to perform this action.",
          ),
        );
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export default authorizePermission;
