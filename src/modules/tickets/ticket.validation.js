import ApiError from "../../utils/ApiError.js";

/**
 * Ticket lifecycle states and allowed transitions.
 * Kept here so routes, services, and tests share one source of truth.
 */
export const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

export const TICKET_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

/**
 * Validation schema for POST /api/v1/tickets
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
    pattern: new RegExp(`^(${TICKET_PRIORITIES.join("|")})$`, "i"),
    message: `priority must be one of ${TICKET_PRIORITIES.join(", ")}`,
  },
  source: {
    type: "string",
    required: false,
    pattern: /^(Email|Phone|Chat|Web|Portal)$/i,
    message: "source must be one of Email, Phone, Chat, Web, Portal",
  },
  customer_id: {
    required: false,
    nullable: true,
  },
  customer_name: {
    type: "string",
    required: false,
    maxLength: 100,
  },
  customer_email: {
    type: "string",
    required: false,
    maxLength: 255,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: "customer_email must be a valid email address",
  },
  tags: {
    required: false,
    nullable: true,
  },
};

export const createTicketOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};

/**
 * Validation schema for PATCH /api/v1/tickets/:id
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
 * Validate a reference ID coming from a request body.
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
