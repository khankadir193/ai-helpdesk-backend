import ApiError from "../../utils/ApiError.js";

/**
 * Ticket lifecycle states and allowed transitions.
 * Kept here so routes, services, and tests share one source of truth.
 */
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

export const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

/**
 * Validation schema for POST /api/v1/tickets
 *
 * category_id is not type-checked by `validate` because the middleware only
 * understands string/boolean; the service re-validates it with the same
 * positive-integer rule used everywhere else (see service layer).
 */
export const createTicketSchema = {
  title: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 200,
  },
  description: {
    type: "string",
    required: true,
    minLength: 1,
  },
  category_id: {
    required: false,
    nullable: true,
  },
  priority: {
    type: "string",
    required: false,
    pattern: new RegExp(`^(${TICKET_PRIORITIES.join("|")})$`),
    message: `priority must be one of ${TICKET_PRIORITIES.join(", ")}`,
  },
};

export const createTicketOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};

/**
 * Validation schema for PATCH /api/v1/tickets/:id
 *
 * Deliberately excludes `status` (use /:id/status) and
 * `assigned_agent_id` (use /:id/assignment); `rejectUnknown` turns
 * attempts to send them into a 422 so the contract stays explicit.
 */
export const updateTicketSchema = {
  title: {
    type: "string",
    required: false,
    minLength: 1,
    maxLength: 200,
  },
  description: {
    type: "string",
    required: false,
    minLength: 1,
  },
  category_id: {
    required: false,
    nullable: true,
  },
  priority: {
    type: "string",
    required: false,
    pattern: new RegExp(`^(${TICKET_PRIORITIES.join("|")})$`),
    message: `priority must be one of ${TICKET_PRIORITIES.join(", ")}`,
  },
};

export const updateTicketOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
  requireAtLeastOneOf: ["title", "description", "category_id", "priority"],
};

/**
 * Validation schema for PATCH /api/v1/tickets/:id/status
 */
export const updateStatusSchema = {
  status: {
    type: "string",
    required: true,
    pattern: new RegExp(`^(${TICKET_STATUSES.join("|")})$`),
    message: `status must be one of ${TICKET_STATUSES.join(", ")}`,
  },
};

export const updateStatusOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};

/**
 * Validation schema for PATCH /api/v1/tickets/:id/assignment
 *
 * `assigned_agent_id` may be null to unassign. Type/format is validated in
 * the service (target must be a positive integer referencing an active agent).
 */
export const updateAssignmentSchema = {
  assigned_agent_id: {
    required: false,
    nullable: true,
  },
};

export const updateAssignmentOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
  requireAtLeastOneOf: ["assigned_agent_id"],
};

/**
 * Middleware to validate a ticket ID in request parameters.
 * Must be a positive integer matching a BIGINT id.
 */
export function validateTicketId(req, _res, next) {
  const { id } = req.params;
  if (!id || !/^[1-9]\d*$/.test(id)) {
    return next(new ApiError(400, "Invalid ticket ID. Must be a positive integer."));
  }
  next();
}

/**
 * Validate a reference ID coming from a request body (e.g. an agent id for
 * ticket assignment). Returns the normalized integer string, or null when
 * the caller explicitly passes null/undefined and null is allowed.
 * Throws ApiError(400) on any other non-positive-integer input.
 *
 * @param {unknown} value
 * @param {{ allowNull?: boolean }} options
 * @returns {string|null}
 */
export function validateModelId(value, options = {}) {
  if (value === null || value === undefined) {
    if (options.allowNull) {
      return null;
    }
    throw new ApiError(400, "ID must be a positive integer.");
  }
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^[1-9]\d*$/.test(String(value))
  ) {
    throw new ApiError(400, "ID must be a positive integer.");
  }
  return String(value);
}
