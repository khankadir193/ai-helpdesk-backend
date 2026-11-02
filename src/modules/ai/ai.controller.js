import aiService from "./ai.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * POST /api/v1/tickets/:id/ai/classify — AGENT (assigned) or ADMIN.
 *
 * No request body is required; the ticket content, active categories, and
 * requesting user all come from the server side. The suggestion is stored
 * with status PENDING; the ticket is never modified automatically.
 *
 * Response 200:
 *   { status: "success", data: { suggestion: {...} } }
 */
const classifyTicket = asyncHandler(async (req, res) => {
  const suggestion = await aiService.classifyTicket(
    req.params.id,
    req.user,
  );

  res.status(200).json({
    status: "success",
    data: { suggestion },
  });
});

/**
 * POST /api/v1/tickets/:id/ai/priority — AGENT (assigned) or ADMIN.
 *
 * Same contract as classification: no request body; the ticket content and
 * requesting user come from the server side. The suggestion is stored in
 * ai_suggestions with suggestion_type PRIORITY and status PENDING; the
 * ticket's actual priority is never changed automatically.
 *
 * Response 200:
 *   { status: "success", data: { suggestion: {...} } }
 */
const suggestPriority = asyncHandler(async (req, res) => {
  const suggestion = await aiService.suggestTicketPriority(
    req.params.id,
    req.user,
  );

  res.status(200).json({
    status: "success",
    data: { suggestion },
  });
});

/**
 * POST /api/v1/tickets/:id/ai/reply-draft — AGENT (assigned) or ADMIN.
 *
 * No request body is required; the ticket content, the customer-visible
 * comment thread, and the requesting user all come from the server side.
 * The draft is generated ONLY: it is stored in ai_suggestions with
 * suggestion_type REPLY_DRAFT and status PENDING. It is never sent
 * automatically and never becomes a ticket comment until the agent
 * explicitly chooses to post it (edit / regenerate / discard are agent
 * decisions); the ticket is never modified automatically.
 *
 * Response 200:
 *   { status: "success", data: { suggestion: {...} } }
 */
const generateReplyDraft = asyncHandler(async (req, res) => {
  const suggestion = await aiService.generateReplyDraft(
    req.params.id,
    req.user,
  );

  res.status(200).json({
    status: "success",
    data: { suggestion },
  });
});

export default {
  classifyTicket,
  suggestPriority,
  generateReplyDraft,
};
