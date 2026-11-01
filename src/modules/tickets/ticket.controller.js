import ticketService from "./ticket.service.js";
import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

const SORT_FIELDS = ["created_at", "updated_at"];
const MAX_PAGE_LIMIT = 100;

/**
 * Parse `page` and `limit` query params with safe defaults.
 * Throws ApiError(400) on invalid values.
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
 * Parse `sort` and `order` query params with safe defaults. The values are
 * whitelisted so they can never inject into the ORDER BY clause.
 *
 * @param {object} query
 * @returns {{ sort: string, order: string }}
 */
function parseSorting(query) {
  let sort = "created_at";
  if (query.sort !== undefined && query.sort !== "") {
    if (!SORT_FIELDS.includes(query.sort)) {
      throw new ApiError(
        400,
        `sort must be one of ${SORT_FIELDS.join(", ")}.`,
      );
    }
    sort = query.sort;
  }

  let order = "desc";
  if (query.order !== undefined && query.order !== "") {
    const normalized = String(query.order).trim().toLowerCase();
    if (normalized !== "asc" && normalized !== "desc") {
      throw new ApiError(400, "order must be 'asc' or 'desc'.");
    }
    order = normalized;
  }

  return { sort, order };
}

/**
 * Convert an empty query value to undefined so the service treats it as
 * "filter not provided".
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function pickParam(value) {
  if (value === undefined || value === "" || value === null) {
    return undefined;
  }
  return String(value);
}

/**
 * POST /api/v1/tickets — CUSTOMER only.
 *
 * Request body (validated upstream): { title, description, category_id?, priority? }
 *
 * Response 201:
 *   { status: "success", data: { ticket: {...} } }
 */
const createTicket = asyncHandler(async (req, res) => {
  const { title, description, category_id, priority } = req.body;

  const ticket = await ticketService.createTicket({
    title,
    description,
    customer_id: req.user.id,
    category_id,
    priority,
  });

  res.status(201).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * GET /api/v1/tickets
 *
 * Query params:
 *   - status, priority, category_id   (all roles)
 *   - assigned_agent_id               (admin only)
 *   - sort   : "created_at" | "updated_at"   (default created_at)
 *   - order  : "asc" | "desc"                (default desc)
 *   - page   : positive integer              (default 1)
 *   - limit  : 1–100                          (default 20)
 *
 * Response 200:
 *   { status: "success",
 *     data: { tickets: [...],
 *             pagination: { page, limit, total_items, total_pages } } }
 */
const listTickets = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { sort, order } = parseSorting(req.query);

  const { tickets, pagination } = await ticketService.listTickets({
    user: req.user,
    status: pickParam(req.query.status),
    priority: pickParam(req.query.priority),
    categoryId: pickParam(req.query.category_id),
    assignedAgentId: pickParam(req.query.assigned_agent_id),
    sort,
    order,
    page,
    limit,
  });

  res.status(200).json({
    status: "success",
    data: { tickets, pagination },
  });
});

/**
 * GET /api/v1/tickets/:id
 *
 * Response 200: { status: "success", data: { ticket } }
 */
const getTicketById = asyncHandler(async (req, res) => {
  const ticket = await ticketService.getTicketById(req.params.id, req.user);

  res.status(200).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * PATCH /api/v1/tickets/:id
 *
 * Editable fields: title, description, category_id, priority.
 * Role/state restrictions enforced in the service.
 *
 * Response 200: { status: "success", data: { ticket } }
 */
const updateTicket = asyncHandler(async (req, res) => {
  const { title, description, category_id, priority } = req.body;

  const ticket = await ticketService.updateTicket(req.params.id, req.user, {
    title,
    description,
    category_id,
    priority,
  });

  res.status(200).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * PATCH /api/v1/tickets/:id/status — AGENT (assigned) or ADMIN.
 *
 * Request body: { status }
 *
 * Response 200: { status: "success", data: { ticket } }
 */
const updateTicketStatus = asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateTicketStatus(
    req.params.id,
    req.user,
    req.body.status,
  );

  res.status(200).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * PATCH /api/v1/tickets/:id/assignment — ADMIN only.
 *
 * Request body: { assigned_agent_id } | { assigned_agent_id: null } to unassign.
 *
 * Response 200: { status: "success", data: { ticket } }
 */
const updateTicketAssignment = asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateTicketAssignment(
    req.params.id,
    req.user,
    req.body.assigned_agent_id,
  );

  res.status(200).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * GET /api/v1/tickets/:id/history — AGENT (assigned) or ADMIN.
 *
 * Response 200: { status: "success", data: { history: [...] } }
 */
const getTicketHistory = asyncHandler(async (req, res) => {
  const history = await ticketService.getTicketHistory(req.params.id, req.user);

  res.status(200).json({
    status: "success",
    data: { history },
  });
});

export default {
  createTicket,
  listTickets,
  getTicketById,
  updateTicket,
  updateTicketStatus,
  updateTicketAssignment,
  getTicketHistory,
};
