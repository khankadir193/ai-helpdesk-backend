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

export default {
  classifyTicket,
};
