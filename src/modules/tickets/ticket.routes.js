import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
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

// POST / - Customer creates a ticket
router.post(
  "/",
  authorize("CUSTOMER"),
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

// PATCH /:id/status - Agent (assigned) or admin changes ticket status
router.patch(
  "/:id/status",
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  validate(updateStatusSchema, updateStatusOptions),
  ticketController.updateTicketStatus
);

// PATCH /:id/assignment - Admin assigns/unassigns the ticket to an agent
router.patch(
  "/:id/assignment",
  authorize("ADMIN"),
  validateTicketId,
  validate(updateAssignmentSchema, updateAssignmentOptions),
  ticketController.updateTicketAssignment
);

// GET /:id/history - Audit trail (agent scoped to assigned tickets; admin all)
router.get(
  "/:id/history",
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  ticketController.getTicketHistory
);

export default router;
