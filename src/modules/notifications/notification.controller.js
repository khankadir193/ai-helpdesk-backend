import notificationService from "./notification.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

/**
 * GET /api/v1/notifications
 * List notifications for the authenticated user and unread count.
 */
const getNotifications = asyncHandler(async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 30;
  const data = await notificationService.listNotifications(req.user.id, { limit });

  res.status(200).json({
    status: "success",
    data,
  });
});

/**
 * PATCH /api/v1/notifications/:id/read
 * Mark a single notification as read.
 */
const markAsRead = asyncHandler(async (req, res) => {
  const notification = await notificationService.markAsRead(req.user.id, req.params.id);

  res.status(200).json({
    status: "success",
    data: { notification },
  });
});

/**
 * PATCH /api/v1/notifications/read-all
 * Mark all notifications as read for the authenticated user.
 */
const markAllAsRead = asyncHandler(async (req, res) => {
  const result = await notificationService.markAllAsRead(req.user.id);

  res.status(200).json({
    status: "success",
    data: result,
  });
});

export default {
  getNotifications,
  markAsRead,
  markAllAsRead,
};
