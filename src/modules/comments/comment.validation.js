/**
 * Validation schema for POST /api/v1/tickets/:id/comments
 *
 * `message` is required and must not be blank; `is_internal` is an optional
 * boolean. Whether the caller may set `is_internal: true` is a permission
 * decision enforced in the service layer (customers cannot).
 */
export const createCommentSchema = {
  message: {
    type: "string",
    required: true,
    minLength: 1,
  },
  is_internal: {
    type: "boolean",
    required: false,
  },
};

export const createCommentOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};
