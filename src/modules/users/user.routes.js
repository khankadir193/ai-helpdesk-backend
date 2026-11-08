import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import userController from "./user.controller.js";

const router = express.Router();

// Enforce authentication on all user endpoints.
// The current user identity is always resolved fresh from the database by
// the middleware (role is never client-supplied).
router.use(authenticate);

// GET /agents - Admin only: active support-agent directory for assignment.
// No user-management write operations are exposed by this module.
router.get("/agents", authorize("ADMIN"), userController.listAgents);

export default router;
