import dashboardService from "./dashboard.service.js";
import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

const MAX_PAGE_LIMIT = 100;

/** ISO-8601 date string pattern (YYYY-MM-DD). */
const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/**
 * Parse `page` and `limit` query params with safe defaults.
 * Throws ApiError(400) on invalid values. Same rules and limits as the
 * tickets listing endpoint so both list surfaces paginate identically.
 *
 * @param {object} query
 * @returns {{ page: number, limit: number }}
 */
function parsePagination(query) {
  let page = 1;
  let limit = 20;

  if (query.page !== undefined) {
    page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError(400, "page must be a positive integer.");
    }
  }

  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new ApiError(
        400,
        `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
      );
    }
  }

  return { page, limit };
}

/**
 * Parse optional `startDate` / `endDate` query params (YYYY-MM-DD, UTC).
 * Both are optional; when only one is provided it is used as a one-sided
 * bound. Returns null for absent/invalid values so the service falls back
 * to its default window.
 *
 * @param {object} query
 * @returns {{ startDate: string|null, endDate: string|null }}
 */
function parseDateRange(query) {
  let startDate = null;
  let endDate = null;

  if (query.startDate !== undefined) {
    if (!ISO_DATE_RE.test(query.startDate)) {
      throw new ApiError(400, "startDate must be a valid date in YYYY-MM-DD format.");
    }
    startDate = query.startDate;
  }

  if (query.endDate !== undefined) {
    if (!ISO_DATE_RE.test(query.endDate)) {
      throw new ApiError(400, "endDate must be a valid date in YYYY-MM-DD format.");
    }
    endDate = query.endDate;
  }

  if (startDate && endDate && startDate > endDate) {
    throw new ApiError(400, "startDate must not be after endDate.");
  }

  return { startDate, endDate };
}

/**
 * GET /api/v1/dashboard
 *
 * Role-based dashboard data. The role is taken from the authenticated
 * session (never from the request): ADMIN returns every-ticket aggregates
 * plus category counts and agent workload; AGENT returns assigned-ticket
 * statistics where scope is enforced server-side; CUSTOMER returns
 * statistics for their own tickets only.
 *
 * Query params:
 *   page       (positive integer, default 1)
 *   limit      (1–100, default 20)   — applied to `recent_tickets` only
 *   startDate  (YYYY-MM-DD, UTC)     — optional lower bound on created_at
 *   endDate    (YYYY-MM-DD, UTC)     — optional upper bound on created_at
 *
 * Response 200:
 *   { status: "success", data: { dashboard: {...} } }
 */
const getDashboard = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { startDate, endDate } = parseDateRange(req.query);
  const dashboard = await dashboardService.getDashboard(req.user, {
    page,
    limit,
    startDate,
    endDate,
  });

  res.status(200).json({
    status: "success",
    data: { dashboard },
  });
});

export default {
  getDashboard,
};
