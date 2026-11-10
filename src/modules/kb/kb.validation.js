import ApiError from "../../utils/ApiError.js";

/**
 * Validation schemas and param helpers for Knowledge Base module.
 */

export const createArticleSchema = {
  title: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 255,
  },
  summary: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 1000,
  },
  content: {
    type: "string",
    required: false,
    nullable: true,
  },
  category_id: {
    type: "number",
    required: true,
  },
  visibility: {
    type: "string",
    required: false,
  },
  tags: {
    type: "string", // can accept comma-delimited or string
    required: false,
  },
  status: {
    type: "string",
    required: false,
  },
};

export const updateArticleSchema = {
  title: {
    type: "string",
    required: false,
    minLength: 1,
    maxLength: 255,
  },
  summary: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 1000,
  },
  content: {
    type: "string",
    required: false,
    nullable: true,
  },
  category_id: {
    type: "number",
    required: false,
  },
  visibility: {
    type: "string",
    required: false,
  },
  tags: {
    type: "string",
    required: false,
  },
  status: {
    type: "string",
    required: false,
  },
  author_id: {
    type: "number",
    required: false,
  },
};

export const createCategorySchema = {
  name: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 120,
  },
  description: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 500,
  },
  icon: {
    type: "string",
    required: false,
    maxLength: 50,
  },
  owner_id: {
    type: "number",
    required: false,
    nullable: true,
  },
};

export const updateCategorySchema = {
  name: {
    type: "string",
    required: false,
    minLength: 1,
    maxLength: 120,
  },
  description: {
    type: "string",
    required: false,
    nullable: true,
    maxLength: 500,
  },
  icon: {
    type: "string",
    required: false,
    maxLength: 50,
  },
  owner_id: {
    type: "number",
    required: false,
    nullable: true,
  },
};

export function validateArticleIdentifier(req, _res, next) {
  const { id } = req.params;
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    return next(new ApiError(400, "Invalid article identifier."));
  }
  next();
}

export function validateCategoryId(req, _res, next) {
  const { id } = req.params;
  if (!id || !/^[1-9]\d*$/.test(id)) {
    return next(new ApiError(400, "Invalid category ID. Must be a positive integer."));
  }
  next();
}

