import categoryService from "./category.service.js";
import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";

/**
 * GET /api/v1/categories
 *
 * Query params (admin only):
 *   - is_active: "true" | "false"
 *
 * Response 200:
 *   { status: "success", data: { categories: [...] } }
 */
const listCategories = asyncHandler(async (req, res) => {
  let isActive = null;

  if (req.query.is_active !== undefined) {
    if (req.query.is_active === "true") {
      isActive = true;
    } else if (req.query.is_active === "false") {
      isActive = false;
    } else {
      throw new ApiError(
        400,
        "is_active query parameter must be 'true' or 'false'."
      );
    }
  }

  const categories = await categoryService.listCategories({
    role: req.user.role,
    isActive,
  });

  res.status(200).json({
    status: "success",
    data: { categories },
  });
});

/**
 * GET /api/v1/categories/:id
 *
 * Response 200:
 *   { status: "success", data: { category: {...} } }
 */
const getCategoryById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const category = await categoryService.getCategoryById(id, {
    role: req.user.role,
  });

  res.status(200).json({
    status: "success",
    data: { category },
  });
});

/**
 * POST /api/v1/categories
 * Admin only.
 *
 * Response 201:
 *   { status: "success", data: { category: {...} } }
 */
const createCategory = asyncHandler(async (req, res) => {
  const { name, description, is_active } = req.body;

  const category = await categoryService.createCategory({
    name,
    description,
    is_active,
  });

  res.status(201).json({
    status: "success",
    data: { category },
  });
});

/**
 * PATCH /api/v1/categories/:id
 * Admin only.
 *
 * Response 200:
 *   { status: "success", data: { category: {...} } }
 */
const updateCategory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, is_active } = req.body;

  const category = await categoryService.updateCategory(id, {
    name,
    description,
    is_active,
  });

  res.status(200).json({
    status: "success",
    data: { category },
  });
});

/**
 * PATCH /api/v1/categories/:id/status
 * Admin only.
 *
 * Response 200:
 *   { status: "success", data: { category: {...} } }
 */
const updateCategoryStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  const category = await categoryService.updateCategoryStatus(id, is_active);

  res.status(200).json({
    status: "success",
    data: { category },
  });
});

export default {
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  updateCategoryStatus,
};
