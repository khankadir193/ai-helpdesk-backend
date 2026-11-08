import reportsService from "./reports.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/v1/reports/analytics
 *
 * Query params (all optional):
 *   date_from  ISO date string — start of the analysis window (default: 30 days ago)
 *   date_to    ISO date string — end   of the analysis window (default: today)
 *   agent_id   Positive integer — filter to a single agent (ADMIN only; ignored for AGENT callers)
 *   channel    Accepted but ignored — no channel concept in the current schema
 *
 * Response 200:
 *   { status: "success", data: { analytics: { period, kpis, ticket_volume, sla, agent_performance, csat } } }
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const analytics = await reportsService.getAnalytics(req.user, req.query);

  res.status(200).json({
    status: "success",
    data: { analytics },
  });
});

export default {
  getAnalytics,
};

