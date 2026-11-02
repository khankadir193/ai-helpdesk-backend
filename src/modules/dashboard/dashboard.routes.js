import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import dashboardController from "./dashboard.controller.js";

const router = express.Router();

// Enforce authentication on all dashboard endpoints
router.use(authenticate);

// GET / - Role-based dashboard data. Scoping is decided server-side from
// the authenticated user's role (customers see their own tickets,
// agents their assigned tickets, admins everything).
router.get(
  "/",
  authorize("CUSTOMER", "AGENT", "ADMIN"),
  dashboardController.getDashboard,
);

export default router;
