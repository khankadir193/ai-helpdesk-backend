import express from "express";
import authenticate from "../../middleware/authenticate.js";
import notificationController from "./notification.controller.js";

const router = express.Router();

// Enforce authentication on all notification endpoints
router.use(authenticate);

// GET / - List notifications and unread count for current user
router.get("/", notificationController.getNotifications);

// PATCH /read-all - Mark all as read
router.patch("/read-all", notificationController.markAllAsRead);

// PATCH /:id/read - Mark one notification as read
router.patch("/:id/read", notificationController.markAsRead);

export default router;
