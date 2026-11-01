import commentService from "./comment.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/v1/tickets/:id/comments
 *
 * Returns the comment thread of one ticket (oldest first). Internal
 * comments are filtered out for CUSTOMER callers (FR-012/FR-022 rules are
 * enforced in the service).
 *
 * Response 200: { status: "success", data: { comments: [...] } }
 */
const listComments = asyncHandler(async (req, res) => {
  const comments = await commentService.listComments(req.params.id, req.user);

  res.status(200).json({
    status: "success",
    data: { comments },
  });
});

/**
 * POST /api/v1/tickets/:id/comments
 *
 * Append a comment to a ticket. Body (validated upstream):
 *   { message, is_internal? }
 * The author is always the authenticated user (req.user.id) and can never
 * be spoofed from the request body.
 *
 * Response 201: { status: "success", data: { comment } }
 */
const addComment = asyncHandler(async (req, res) => {
  const comment = await commentService.addComment(
    req.params.id,
    req.user,
    req.body,
  );

  res.status(201).json({
    status: "success",
    data: { comment },
  });
});

export default {
  listComments,
  addComment,
};
