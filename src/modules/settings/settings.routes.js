import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import validate from "../../middleware/validate.js";
import settingsController from "./settings.controller.js";
import {
  patchWorkspaceSchema,
  patchProfileSchema,
  changePasswordSchema,
  patchTeamSchema,
  patchAiSchema,
} from "./settings.validation.js";

const router = express.Router();

const isProduction = process.env.NODE_ENV === "production";

// Rate limiting for password change and 2FA operations
const sensitiveActionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: isProduction ? 10 : 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientIp = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const normalizedIp = ipKeyGenerator(clientIp);
    return req.session?.userId
      ? `${normalizedIp}_user_${req.session.userId}`
      : normalizedIp;
  },
  message: {
    status: "error",
    message: "Too many attempts, please try again after 15 minutes.",
  },
});

// All settings routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// 1. Workspace settings
// ---------------------------------------------------------------------------
router.get("/workspace", settingsController.getWorkspace);
router.get("/workspace/check-url", settingsController.checkWorkspaceUrl);
router.patch(
  "/workspace",
  authorize("ADMIN"),
  validate(patchWorkspaceSchema, { disallowEmpty: true }),
  settingsController.patchWorkspace
);

// ---------------------------------------------------------------------------
// 2. Profile settings
// ---------------------------------------------------------------------------
router.get("/profile", settingsController.getProfile);
router.patch(
  "/profile",
  validate(patchProfileSchema, { disallowEmpty: true }),
  settingsController.patchProfile
);
router.post("/profile/avatar", settingsController.uploadAvatar);
router.post(
  "/profile/password",
  sensitiveActionRateLimit,
  validate(changePasswordSchema),
  settingsController.changePassword
);
router.get("/profile/2fa", settingsController.get2fa);
router.post("/profile/2fa", sensitiveActionRateLimit, settingsController.patch2fa);

// Sessions
router.get("/sessions", settingsController.getSessions);
router.post("/sessions/revoke-others", settingsController.revokeOtherSessions);

// ---------------------------------------------------------------------------
// 3. Team settings
// ---------------------------------------------------------------------------
router.get("/team", settingsController.getTeam);
router.patch(
  "/team",
  authorize("ADMIN"),
  validate(patchTeamSchema, { disallowEmpty: true }),
  settingsController.patchTeam
);

// ---------------------------------------------------------------------------
// 4. Notification settings
// ---------------------------------------------------------------------------
router.get("/notifications", settingsController.getNotifications);
router.patch("/notifications", settingsController.patchNotifications);

// ---------------------------------------------------------------------------
// 5. AI settings
// ---------------------------------------------------------------------------
router.get("/ai", settingsController.getAi);
router.get("/ai/preview", settingsController.getAiPreview);
router.patch(
  "/ai",
  authorize("ADMIN"),
  validate(patchAiSchema, { disallowEmpty: true }),
  settingsController.patchAi
);

export default router;

