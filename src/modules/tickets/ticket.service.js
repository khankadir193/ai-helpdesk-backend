import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";
import categoryService from "../categories/category.service.js";

/**
 * Validates that a category can be assigned to a new ticket.
 * Inactive categories are forbidden for new tickets.
 *
 * @param {string|number|null} categoryId
 * @returns {Promise<object|null>}
 */
async function validateTicketCategory(categoryId) {
  if (categoryId === undefined || categoryId === null) {
    return null;
  }
  return categoryService.ensureCategoryIsActive(categoryId);
}

/**
 * Create a new ticket, enforcing that inactive categories cannot be used.
 *
 * @param {{
 *   title: string,
 *   description: string,
 *   customer_id: string|number,
 *   category_id?: string|number|null,
 *   priority?: string
 * }} data
 * @returns {Promise<object>}
 */
async function createTicket({
  title,
  description,
  customer_id,
  category_id = null,
  priority = "MEDIUM",
}) {
  if (!title || !title.trim()) {
    throw new ApiError(422, "Ticket title is required.");
  }
  if (!description || !description.trim()) {
    throw new ApiError(422, "Ticket description is required.");
  }
  if (!customer_id) {
    throw new ApiError(422, "Customer ID is required.");
  }

  // Enforce category active check
  if (category_id !== null && category_id !== undefined) {
    await validateTicketCategory(category_id);
  }

  const { rows } = await database.query(
    `INSERT INTO tickets (title, description, customer_id, category_id, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, description, customer_id, category_id, priority, status, created_at, updated_at`,
    [
      title.trim(),
      description.trim(),
      customer_id,
      category_id,
      priority,
    ]
  );

  return rows[0];
}

export default {
  validateTicketCategory,
  createTicket,
};
