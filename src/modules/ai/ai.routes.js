import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import aiController from "./ai.controller.js";
import { validateTicketId } from "../tickets/ticket.validation.js";

const router = express.Router();

// Enforce authentication on all AI endpoints
router.use(authenticate);

// POST /:id/ai/classify - AI ticket classification (AGENT assigned / ADMIN,
// ownership scoping enforced in the service)
router.post(
  "/:id/ai/classify",
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  aiController.classifyTicket,
);

export default router;
