import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";

/**
 * Notification service — handles user notifications, unread counts,
 * and mark-as-read updates. All actions are scoped to the authenticated user.
 */

/**
 * Format a database row into a client-safe notification object.
 */
function serializeNotification(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    ticket_id: row.ticket_id ? String(row.ticket_id) : null,
    title: row.title,
    subtitle: row.subtitle || "",
    is_read: Boolean(row.is_read),
    unread: !row.is_read,
    created_at: row.created_at,
  };
}

/**
 * List notifications for a user, sorted newest first.
 * Also returns the unread count.
 *
 * @param {string|number} userId
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ notifications: Array<object>, unread_count: number }>}
 */
async function listNotifications(userId, { limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);

  const { rows } = await database.query(
    `SELECT id, user_id, ticket_id, title, subtitle, is_read, created_at
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, safeLimit],
  );

  const { rows: countRows } = await database.query(
    `SELECT COUNT(*)::int AS unread_count
     FROM notifications
     WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  );

  return {
    notifications: rows.map(serializeNotification),
    unread_count: countRows[0]?.unread_count ?? 0,
  };
}

/**
 * Mark a single notification as read.
 *
 * @param {string|number} userId
 * @param {string|number} notificationId
 * @returns {Promise<object>} updated notification
 */
async function markAsRead(userId, notificationId) {
  const id = Number(notificationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, "Invalid notification id.");
  }

  const { rows } = await database.query(
    `UPDATE notifications
     SET is_read = TRUE
     WHERE id = $1 AND user_id = $2
     RETURNING id, user_id, ticket_id, title, subtitle, is_read, created_at`,
    [id, userId],
  );

  if (rows.length === 0) {
    throw new ApiError(404, "Notification not found.");
  }

  return serializeNotification(rows[0]);
}

/**
 * Mark all notifications as read for a user.
 *
 * @param {string|number} userId
 * @returns {Promise<{ count: number }>}
 */
async function markAllAsRead(userId) {
  const { rowCount } = await database.query(
    `UPDATE notifications
     SET is_read = TRUE
     WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  );

  return { count: rowCount ?? 0 };
}

/**
 * Create a new notification for a user.
 *
 * @param {object} params
 * @param {string|number} params.userId
 * @param {string|number} [params.ticketId]
 * @param {string} params.title
 * @param {string} [params.subtitle]
 * @returns {Promise<object>}
 */
async function createNotification({ userId, ticketId, title, subtitle }) {
  if (!userId || !title?.trim()) {
    throw new ApiError(400, "userId and title are required for a notification.");
  }

  const { rows } = await database.query(
    `INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read)
     VALUES ($1, $2, $3, $4, FALSE)
     RETURNING id, user_id, ticket_id, title, subtitle, is_read, created_at`,
    [userId, ticketId ? Number(ticketId) : null, title.trim(), subtitle?.trim() || null],
  );

  return serializeNotification(rows[0]);
}

export default {
  listNotifications,
  markAsRead,
  markAllAsRead,
  createNotification,
};
