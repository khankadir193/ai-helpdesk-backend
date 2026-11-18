/**
 * rolePermissions.js — permission middleware for the team module's routes.
 *
 * Thin re-export of the shared permission-aware authorization middleware so
 * team and settings routes can gate endpoints by the persisted role
 * permission matrix (Team → Roles & permissions) instead of fixed roles.
 *
 * `requirePermission(permissionId, minLevel = 1)` denies the request with
 * 403 unless the caller's role resolves an access level >= minLevel from the
 * matrix. Values are stored per ROLE in team_role_permissions, so changes
 * apply to every existing and newly created user of that role. Essential
 * Admin permissions (edit_roles_permissions, billing_security_settings)
 * always resolve as allowed for ADMIN — administrators cannot lock
 * themselves out.
 */
export { default as requirePermission } from "../../middleware/authorizePermission.js";
