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

// POST / - Ticket creation, governed by the configurable "Ticket creation"
// permission (defaults: CUSTOMER allowed, AGENT/ADMIN not allowed).
router.post(
  "/",
  authorizePermission("create_tickets"),
  validate(createTicketSchema, createTicketOptions),
  ticketController.createTicket
);

// GET / - List tickets scoped by role (customer: own, agent: assigned, admin: all)
router.get("/", ticketController.listTickets);

// GET /:id - Retrieve one ticket (ownership-scoped inside the service)
router.get("/:id", validateTicketId, ticketController.getTicketById);

// PATCH /:id - Edit ticket details (role- and state-scoped in the service)
router.patch(
  "/:id",
  validateTicketId,
  validate(updateTicketSchema, updateTicketOptions),
  ticketController.updateTicket
);

// PATCH /:id/status - governed by the configurable "Status updates"
// permission; per-ticket ownership scoping is enforced in the service.
router.patch(
  "/:id/status",
  authorizePermission("update_status"),
  validateTicketId,
  validate(updateStatusSchema, updateStatusOptions),
  ticketController.updateTicketStatus
);

// PATCH /:id/assignment - governed by the configurable "Ticket assignment"
// permission (default: ADMIN only). Targets are validated in the service.
router.patch(
  "/:id/assignment",
  authorizePermission("assign_reassign_tickets"),
  validateTicketId,
  validate(updateAssignmentSchema, updateAssignmentOptions),
  ticketController.updateTicketAssignment
);

// GET /:id/history - governed by the configurable "Ticket history"
// permission; per-ticket scoping is enforced in the service.
router.get(
  "/:id/history",
  authorizePermission("ticket_history"),
  validateTicketId,
  ticketController.getTicketHistory
);

export default router;
