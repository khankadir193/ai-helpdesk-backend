import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import reportsController from "./reports.controller.js";

const router = express.Router();

// Enforce authentication on all reports endpoints
router.use(authenticate);

/**
 * GET /api/v1/reports/analytics
 * Returns aggregated analytics for the given date range.
 * Accessible to AGENT (own data only) and ADMIN (all data, optional agent filter).
 */
router.get(
  "/analytics",
  authorize("AGENT", "ADMIN"),
  reportsController.getAnalytics,
);

export default router;

