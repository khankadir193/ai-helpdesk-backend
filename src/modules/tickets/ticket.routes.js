import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorizePermission from "../../middleware/authorizePermission.js";
import validate from "../../middleware/validate.js";
import ticketController from "./ticket.controller.js";
import {
  createTicketSchema,
  createTicketOptions,
  updateTicketSchema,
  updateTicketOptions,
  updateStatusSchema,
  updateStatusOptions,
  updateAssignmentSchema,
  updateAssignmentOptions,
  validateTicketId,
} from "./ticket.validation.js";

const router = express.Router();

// Enforce authentication on all ticket endpoints
router.use(authenticate);

// Middleware to authorize ticket creation:
// - Staff (ADMIN / AGENT / MANAGER) can log tickets on behalf of customers
// - CUSTOMER is governed by the configurable "create_tickets" permission
const authorizeTicketCreation = (req, res, next) => {
  if (req.user && (req.user.role === "ADMIN" || req.user.role === "AGENT" || req.user.role === "MANAGER")) {
    return next();
  }
  return authorizePermission("create_tickets")(req, res, next);
};

// 1. Static and collection-level endpoints (MUST be defined before /:id)

// GET /export - Export tickets matching filters to RFC 4180 CSV
router.get("/export", ticketController.exportTicketsCsv);

// GET /customers - Search active customers for autocomplete in TicketForm
router.get("/customers", ticketController.searchCustomers);

// GET /agents - Directory of active agents with open ticket counts
router.get("/agents", ticketController.getAgentsWithCounts);

// POST /bulk/status - Change status for multiple tickets
router.post("/bulk/status", ticketController.bulkUpdateStatus);

// POST /bulk/assign - Assign/unassign multiple tickets
router.post("/bulk/assign", ticketController.bulkUpdateAssignment);

// POST /bulk/delete - Bulk delete tickets (Admin only)
router.post("/bulk/delete", ticketController.bulkDeleteTickets);

// POST / - Ticket creation
router.post(
  "/",
  authorizeTicketCreation,
  validate(createTicketSchema, createTicketOptions),
  ticketController.createTicket,
);

// GET / - List tickets scoped by role and query filters
router.get("/", ticketController.listTickets);

// 2. Resource-level endpoints parameterized by /:id

// GET /:id - Retrieve one ticket (ownership-scoped inside service)
router.get("/:id", validateTicketId, ticketController.getTicketById);

// PATCH /:id - Edit ticket details (role- and state-scoped in service)
router.patch(
  "/:id",
  validateTicketId,
  validate(updateTicketSchema, updateTicketOptions),
  ticketController.updateTicket,
);

// PATCH /:id/status - Update status
router.patch(
  "/:id/status",
  authorizePermission("update_status"),
  validateTicketId,
  validate(updateStatusSchema, updateStatusOptions),
  ticketController.updateTicketStatus,
);

// PATCH /:id/assignment - Assign/reassign ticket
router.patch(
  "/:id/assignment",
  validateTicketId,
  validate(updateAssignmentSchema, updateAssignmentOptions),
  ticketController.updateTicketAssignment,
);

// DELETE /:id - Delete single ticket (Admin only)
router.delete("/:id", validateTicketId, ticketController.deleteTicket);

// GET /:id/history - Audit trail
router.get(
  "/:id/history",
  authorizePermission("ticket_history"),
  validateTicketId,
  ticketController.getTicketHistory,
);

export default router;
