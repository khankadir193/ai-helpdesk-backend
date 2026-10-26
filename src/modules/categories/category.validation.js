import ApiError from "../../utils/ApiError.js";

/**
 * Validation schema for POST /api/v1/categories
 */
export const createCategorySchema = {
  name: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 80,
  },
  description: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 500,
  },
  is_active: {
    type: "boolean",
    required: false,
  },
};

export const createCategoryOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};

/**
 * Validation schema for PATCH /api/v1/categories/:id
 */
export const updateCategorySchema = {
  name: {
    type: "string",
    required: false,
    minLength: 1,
    maxLength: 80,
  },
  description: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 500,
  },
  is_active: {
    type: "boolean",
    required: false,
  },
};

export const updateCategoryOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
  requireAtLeastOneOf: ["name", "description", "is_active"],
};

/**
 * Validation schema for PATCH /api/v1/categories/:id/status
 */
export const updateStatusSchema = {
  is_active: {
    type: "boolean",
    required: true,
  },
};

export const updateStatusOptions = {
  rejectUnknown: true,
  disallowEmpty: true,
};

/**
 * Middleware to validate category ID in request parameters.
 * Must be a positive integer matching BIGINT id.
 */
export function validateCategoryId(req, _res, next) {
  const { id } = req.params;
  if (!id || !/^[1-9]\d*$/.test(id)) {
    return next(new ApiError(400, "Invalid category ID. Must be a positive integer."));
  }
  next();
}
