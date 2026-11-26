/**
 * Team Routes — REST endpoints for team performance, roles matrix,
 * invitations, and member directory.
 */
import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import authorizePermission from "../../middleware/authorizePermission.js";
import teamController from "./team.controller.js";

const router = express.Router();

// All team endpoints require authentication
router.use(authenticate);

// 1. Team Performance & CSV Export (governed by the configurable view_reports permission)
router.get(
  "/performance",
  authorizePermission("view_reports"),
  teamController.getPerformance,
);
router.get(
  "/performance/export",
  authorizePermission("view_reports"),
  teamController.exportPerformanceCsv,
);

// 2. Roles & Permissions matrix (read requires VIEW, write requires EDIT on edit_roles_permissions)
router.get(
  "/roles",
  authorizePermission("edit_roles_permissions", "VIEW"),
  teamController.getRoles,
);
router.patch(
  "/roles",
  authorizePermission("edit_roles_permissions", "EDIT"),
  teamController.patchRoles,
);
router.post("/roles/request-change", teamController.requestRoleChange);

// 3. Teams list
router.get("/teams", authorize("AGENT", "ADMIN"), teamController.getTeams);

// 4. Invitations & Invite Options (governed by the configurable
//    invite_members permission; granted non-admin inviters may only invite
//    Support Agents — enforced in the service)
router.get("/invite-options", authorizePermission("invite_members"), teamController.getInviteOptions);
router.post("/invitations", authorizePermission("invite_members"), teamController.createInvitation);
router.post(
  "/invitations/:id/resend",
  authorizePermission("invite_members"),
  teamController.resendInvitation,
);
router.delete(
  "/invitations/:id",
  authorizePermission("invite_members"),
  teamController.revokeInvitation,
);

// 5. Members directory (AGENT, ADMIN)
router.get("/members", authorize("AGENT", "ADMIN"), teamController.listMembers);

export default router;
