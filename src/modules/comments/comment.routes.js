import express from "express";
import authenticate from "../../middleware/authenticate.js";
import validate from "../../middleware/validate.js";
import commentController from "./comment.controller.js";
import {
  createCommentSchema,
  createCommentOptions,
} from "./comment.validation.js";
import { validateTicketId } from "../tickets/ticket.validation.js";

const router = express.Router();

// Enforce authentication on all comment endpoints
router.use(authenticate);

// GET /:id/comments - list the comment thread of a ticket
router.get(
  "/:id/comments",
  validateTicketId,
  commentController.listComments,
);

// POST /:id/comments - add a comment (customer/agent/admin, scoped in service)
router.post(
  "/:id/comments",
  validateTicketId,
  validate(createCommentSchema, createCommentOptions),
  commentController.addComment,
);

export default router;
