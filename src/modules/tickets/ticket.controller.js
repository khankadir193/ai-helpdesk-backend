import ticketService from "./ticket.service.js";
import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

const SORT_FIELDS = ["created_at", "updated_at", "id"];
const MAX_PAGE_LIMIT = 100;

function parsePagination(query) {
  let page = 1;
  let limit = 20;

  if (query.page !== undefined && query.page !== "") {
    page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError(400, "page must be a positive integer.");
    }
  }

  if (query.limit !== undefined && query.limit !== "") {
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

function pickParam(value) {
  if (value === undefined || value === "" || value === null) {
    return undefined;
  }
  return String(value);
}

/**
 * POST /api/v1/tickets
 */
const createTicket = asyncHandler(async (req, res) => {
  const ticket = await ticketService.createTicket({
    user: req.user,
    title: req.body.title,
    description: req.body.description,
    customer_id: req.body.customer_id,
    customer_name: req.body.customer_name,
    customer_email: req.body.customer_email,
    category_id: req.body.category_id,
    priority: req.body.priority,
    status: req.body.status,
    assigned_agent_id: req.body.assigned_agent_id,
    source: req.body.source,
    tags: req.body.tags,
    attachments: req.body.attachments,
  });

  res.status(201).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * GET /api/v1/tickets
 */
const listTickets = asyncHandler(async (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { sort, order } = parseSorting(req.query);

  const { tickets, pagination, counts } = await ticketService.listTickets({
    user: req.user,
    tab: pickParam(req.query.tab),
    q: pickParam(req.query.q),
    status: pickParam(req.query.status),
    priority: pickParam(req.query.priority),
    categoryId: pickParam(req.query.category_id),
    assignedAgentId: pickParam(req.query.assigned_agent_id || req.query.agent_id),
    dateRange: pickParam(req.query.date_range),
    from: pickParam(req.query.from),
    to: pickParam(req.query.to),
    sort,
    order,
    page,
    limit,
  });

  res.status(200).json({
    status: "success",
    data: { tickets, pagination, counts },
  });
});

/**
 * GET /api/v1/tickets/export
 */
const exportTicketsCsv = asyncHandler(async (req, res) => {
  const csvData = await ticketService.exportTicketsCsv({
    user: req.user,
    tab: pickParam(req.query.tab),
    q: pickParam(req.query.q),
    status: pickParam(req.query.status),
    priority: pickParam(req.query.priority),
    categoryId: pickParam(req.query.category_id),
    assignedAgentId: pickParam(req.query.assigned_agent_id || req.query.agent_id),
    dateRange: pickParam(req.query.date_range),
    from: pickParam(req.query.from),
    to: pickParam(req.query.to),
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="tickets-export-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.status(200).send(csvData);
});

/**
 * GET /api/v1/tickets/customers
 */
const searchCustomers = asyncHandler(async (req, res) => {
  const customers = await ticketService.searchCustomers(req.query.q, req.user);
  res.status(200).json({
    status: "success",
    data: { customers },
  });
});

/**
 * GET /api/v1/tickets/agents
 */
const getAgentsWithCounts = asyncHandler(async (req, res) => {
  const agents = await ticketService.getAgentsWithOpenCounts(req.user);
  res.status(200).json({
    status: "success",
    data: { agents },
  });
});

/**
 * GET /api/v1/tickets/:id
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
 */
const updateTicket = asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateTicket(req.params.id, req.user, req.body);
  res.status(200).json({
    status: "success",
    data: { ticket },
  });
});

/**
 * PATCH /api/v1/tickets/:id/status
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
 * PATCH /api/v1/tickets/:id/assignment
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
 * DELETE /api/v1/tickets/:id
 */
const deleteTicket = asyncHandler(async (req, res) => {
  await ticketService.deleteTicket(req.params.id, req.user);
  res.status(200).json({
    status: "success",
    message: "Ticket deleted successfully",
  });
});

/**
 * POST /api/v1/tickets/bulk/status
 */
const bulkUpdateStatus = asyncHandler(async (req, res) => {
  const result = await ticketService.bulkUpdateStatus(
    req.body.ticket_ids,
    req.body.status,
    req.user,
  );
  res.status(200).json({
    status: "success",
    data: result,
  });
});

/**
 * POST /api/v1/tickets/bulk/assign
 */
const bulkUpdateAssignment = asyncHandler(async (req, res) => {
  const result = await ticketService.bulkUpdateAssignment(
    req.body.ticket_ids,
    req.body.assigned_agent_id,
    req.user,
  );
  res.status(200).json({
    status: "success",
    data: result,
  });
});

/**
 * POST /api/v1/tickets/bulk/delete
 */
const bulkDeleteTickets = asyncHandler(async (req, res) => {
  const result = await ticketService.bulkDeleteTickets(
    req.body.ticket_ids,
    req.user,
  );
  res.status(200).json({
    status: "success",
    data: result,
  });
});

/**
 * GET /api/v1/tickets/:id/history
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
  exportTicketsCsv,
  searchCustomers,
  getAgentsWithCounts,
  getTicketById,
  updateTicket,
  updateTicketStatus,
  updateTicketAssignment,
  deleteTicket,
  bulkUpdateStatus,
  bulkUpdateAssignment,
  bulkDeleteTickets,
  getTicketHistory,
};
