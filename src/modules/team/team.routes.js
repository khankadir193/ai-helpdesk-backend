/**
 * Team Routes — REST endpoints for team performance, roles matrix,
 * invitations, and member directory.
 */
import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import teamController from "./team.controller.js";

const router = express.Router();

// All team endpoints require authentication
router.use(authenticate);

// 1. Team Performance & CSV Export (accessible to AGENT, MANAGER, ADMIN)
router.get("/performance", authorize("AGENT", "MANAGER", "ADMIN"), teamController.getPerformance);
router.get("/performance/export", authorize("AGENT", "MANAGER", "ADMIN"), teamController.exportPerformanceCsv);

// 2. Roles & Permissions matrix (read by all team roles; write ADMIN only)
router.get("/roles", authorize("AGENT", "MANAGER", "ADMIN"), teamController.getRoles);
router.patch("/roles", authorize("ADMIN"), teamController.patchRoles);
router.post("/roles/request-change", authorize("AGENT", "MANAGER", "ADMIN"), teamController.requestRoleChange);

// 3. Teams list
router.get("/teams", authorize("AGENT", "MANAGER", "ADMIN"), teamController.getTeams);

// 4. Invitations & Invite Options (MANAGER and ADMIN)
router.get("/invite-options", authorize("MANAGER", "ADMIN"), teamController.getInviteOptions);
router.post("/invitations", authorize("MANAGER", "ADMIN"), teamController.createInvitation);
router.post("/invitations/:id/resend", authorize("MANAGER", "ADMIN"), teamController.resendInvitation);
router.delete("/invitations/:id", authorize("MANAGER", "ADMIN"), teamController.revokeInvitation);

// 5. Members directory (AGENT, MANAGER, ADMIN)
router.get("/members", authorize("AGENT", "MANAGER", "ADMIN"), teamController.listMembers);

export default router;
