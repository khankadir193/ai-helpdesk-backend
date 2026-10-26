import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Normalise a category name: strip leading and trailing whitespace.
 * @param {string} raw
 * @returns {string}
 */
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * List categories according to caller's role.
 * - Customers and Agents: only active categories (is_active = true).
 * - Admins: all categories by default, with optional filtering by is_active.
 *
 * @param {{ role: string, isActive?: boolean }} options
 * @returns {Promise<Array<object>>}
 */
async function listCategories({ role, isActive } = {}) {
  let query =
    "SELECT id, name, description, is_active, created_at, updated_at FROM categories";
  const values = [];

  if (role !== "ADMIN") {
    // Customers and agents only see active categories
    query += " WHERE is_active = true";
  } else if (typeof isActive === "boolean") {
    values.push(isActive);
    query += ` WHERE is_active = $${values.length}`;
  }

  query += " ORDER BY id ASC";

  const { rows } = await database.query(query, values);
  return rows;
}

/**
 * Retrieve a single category by ID according to caller's role.
 * - Inactive categories return 404 for customers and agents.
 * - Admins can view both active and inactive categories.
 *
 * @param {string|number} id
 * @param {{ role: string }} options
 * @returns {Promise<object>}
 */
async function getCategoryById(id, { role } = {}) {
  const { rows } = await database.query(
    "SELECT id, name, description, is_active, created_at, updated_at FROM categories WHERE id = $1",
    [id]
  );

  if (rows.length === 0) {
    throw new ApiError(404, "Category not found.");
  }

  const category = rows[0];

  if (role !== "ADMIN" && !category.is_active) {
    throw new ApiError(404, "Category not found.");
  }

  return category;
}

/**
 * Create a new category (admin only).
 * Normalizes name and ensures case-insensitive uniqueness.
 *
 * @param {{ name: string, description?: string|null, is_active?: boolean }} data
 * @returns {Promise<object>}
 */
async function createCategory({ name, description, is_active = true }) {
  const normalizedName = normalizeName(name);

  // Pre-check for duplicate name case-insensitively
  const { rows: existing } = await database.query(
    "SELECT id FROM categories WHERE LOWER(name) = LOWER($1)",
    [normalizedName]
  );

  if (existing.length > 0) {
    throw new ApiError(409, "A category with this name already exists.");
  }

  const cleanDescription =
    typeof description === "string" ? description.trim() : null;
  const activeStatus = is_active ?? true;

  try {
    const { rows } = await database.query(
      `INSERT INTO categories (name, description, is_active)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, is_active, created_at, updated_at`,
      [normalizedName, cleanDescription, activeStatus]
    );

    return rows[0];
  } catch (error) {
    // Catch unique constraint violation (e.g. from concurrent request)
    if (error.code === "23505") {
      throw new ApiError(409, "A category with this name already exists.");
    }
    throw error;
  }
}

/**
 * Update an existing category (admin only).
 *
 * @param {string|number} id
 * @param {{ name?: string, description?: string|null, is_active?: boolean }} data
 * @returns {Promise<object>}
 */
async function updateCategory(id, { name, description, is_active }) {
  // Check if category exists
  const { rows: existingRows } = await database.query(
    "SELECT id, name, description, is_active FROM categories WHERE id = $1",
    [id]
  );

  if (existingRows.length === 0) {
    throw new ApiError(404, "Category not found.");
  }

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const normalizedName = normalizeName(name);

    // Case-insensitive duplicate check against other categories
    const { rows: duplicate } = await database.query(
      "SELECT id FROM categories WHERE LOWER(name) = LOWER($1) AND id != $2",
      [normalizedName, id]
    );

    if (duplicate.length > 0) {
      throw new ApiError(409, "A category with this name already exists.");
    }

    values.push(normalizedName);
    updates.push(`name = $${values.length}`);
  }

  if (description !== undefined) {
    const cleanDescription =
      typeof description === "string" ? description.trim() : null;
    values.push(cleanDescription);
    updates.push(`description = $${values.length}`);
  }

  if (is_active !== undefined) {
    values.push(is_active);
    updates.push(`is_active = $${values.length}`);
  }

  // Update updated_at timestamp
  updates.push("updated_at = NOW()");

  values.push(id);
  const query = `
    UPDATE categories
    SET ${updates.join(", ")}
    WHERE id = $${values.length}
    RETURNING id, name, description, is_active, created_at, updated_at
  `;

  try {
    const { rows } = await database.query(query, values);
    return rows[0];
  } catch (error) {
    if (error.code === "23505") {
      throw new ApiError(409, "A category with this name already exists.");
    }
    throw error;
  }
}

/**
 * Activate or deactivate an existing category (admin only).
 *
 * @param {string|number} id
 * @param {boolean} isActive
 * @returns {Promise<object>}
 */
async function updateCategoryStatus(id, isActive) {
  const { rows: existingRows } = await database.query(
    "SELECT id FROM categories WHERE id = $1",
    [id]
  );

  if (existingRows.length === 0) {
    throw new ApiError(404, "Category not found.");
  }

  const { rows } = await database.query(
    `UPDATE categories
     SET is_active = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, name, description, is_active, created_at, updated_at`,
    [isActive, id]
  );

  return rows[0];
}

/**
 * Validate that a category exists and is active for ticket creation.
 * Used by the ticket creation service.
 *
 * @param {string|number} categoryId
 * @returns {Promise<object>}
 */
async function ensureCategoryIsActive(categoryId) {
  if (!categoryId) return null;

  if (!/^[1-9]\d*$/.test(String(categoryId))) {
    throw new ApiError(400, "Invalid category ID.");
  }

  const { rows } = await database.query(
    "SELECT id, name, is_active FROM categories WHERE id = $1",
    [categoryId]
  );

  if (rows.length === 0) {
    throw new ApiError(404, "Category not found.");
  }

  if (!rows[0].is_active) {
    throw new ApiError(400, "Cannot create ticket with an inactive category.");
  }

  return rows[0];
}

export default {
  normalizeName,
  listCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  updateCategoryStatus,
  ensureCategoryIsActive,
};
