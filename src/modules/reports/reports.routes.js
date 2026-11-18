import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorizePermission from "../../middleware/authorizePermission.js";
import reportsController from "./reports.controller.js";

const router = express.Router();

// Enforce authentication on all reports endpoints
router.use(authenticate);

/**
 * GET /api/v1/reports/analytics
 * Returns aggregated analytics for the given date range.
 * Governed by the configurable "Reports & analytics" permission:
 * 'Workspace' scope sees all data (with an optional agent filter),
 * 'Own performance' scope is restricted to the caller's own data.
 */
router.get(
  "/analytics",
  authorizePermission("view_reports"),
  reportsController.getAnalytics,
);

export default router;

