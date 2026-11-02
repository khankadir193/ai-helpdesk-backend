import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import aiController from "./ai.controller.js";
import { validateTicketId } from "../tickets/ticket.validation.js";

const isProduction = process.env.NODE_ENV === "production";

const aiRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: isProduction ? 30 : 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientIp = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const normalizedIp = ipKeyGenerator(clientIp);
    return req.session?.userId
      ? `${normalizedIp}_user_${req.session.userId}`
      : normalizedIp;
  },
  message: {
    status: "error",
    message: "Too many AI requests. Please try again later.",
  },
});

const router = express.Router();

// Enforce authentication on all AI endpoints
router.use(authenticate);

// POST /:id/ai/classify - AI ticket classification (AGENT assigned / ADMIN,
// ownership scoping enforced in the service)
router.post(
  "/:id/ai/classify",
  aiRateLimit,
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  aiController.classifyTicket,
);

// POST /:id/ai/priority - AI priority suggestion (AGENT assigned / ADMIN,
// ownership scoping enforced in the service). The ticket's priority is
// never modified automatically; applying the suggestion is a human action.
router.post(
  "/:id/ai/priority",
  aiRateLimit,
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  aiController.suggestPriority,
);

// POST /:id/ai/reply-draft - AI reply draft for support agents (AGENT
// assigned / ADMIN, ownership scoping enforced in the service). Draft only:
// the suggestion is stored as pending review; nothing is sent and no
// comment is created until the agent explicitly posts one. The ticket is
// never modified automatically.
router.post(
  "/:id/ai/reply-draft",
  aiRateLimit,
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  aiController.generateReplyDraft,
);

// POST /:id/ai/summary - AI conversation summary for support agents (AGENT
// assigned / ADMIN, ownership scoping enforced in the service). Summary only:
// the suggestion is stored as pending; the ticket's status, priority, and
// category are never modified automatically and no comment is created.
router.post(
  "/:id/ai/summary",
  aiRateLimit,
  authorize("AGENT", "ADMIN"),
  validateTicketId,
  aiController.generateSummary,
);

export default router;
