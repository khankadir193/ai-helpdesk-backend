import express from "express";
import authenticate from "../../middleware/authenticate.js";
import authorize from "../../middleware/authorize.js";
import validate from "../../middleware/validate.js";
import categoryController from "./category.controller.js";
import {
  createCategorySchema,
  createCategoryOptions,
  updateCategorySchema,
  updateCategoryOptions,
  updateStatusSchema,
  updateStatusOptions,
  validateCategoryId,
} from "./category.validation.js";

const router = express.Router();

// Enforce authentication on all category endpoints
router.use(authenticate);

// GET / - List categories (role-dependent visibility)
router.get("/", categoryController.listCategories);

// GET /:id - Retrieve category by ID (role-dependent visibility)
router.get("/:id", validateCategoryId, categoryController.getCategoryById);

// POST / - Admin only: create category
router.post(
  "/",
  authorize("ADMIN"),
  validate(createCategorySchema, createCategoryOptions),
  categoryController.createCategory
);

// PATCH /:id - Admin only: update name, description, or active status
router.patch(
  "/:id",
  authorize("ADMIN"),
  validateCategoryId,
  validate(updateCategorySchema, updateCategoryOptions),
  categoryController.updateCategory
);

// PATCH /:id/status - Admin only: activate or deactivate category
router.patch(
  "/:id/status",
  authorize("ADMIN"),
  validateCategoryId,
  validate(updateStatusSchema, updateStatusOptions),
  categoryController.updateCategoryStatus
);

export default router;
