import settingsService from "./settings.service.js";
import asyncHandler from "../../utils/asyncHandler.js";

// Workspace
const getWorkspace = asyncHandler(async (_req, res) => {
  const workspace = await settingsService.getWorkspaceSettings();
  res.status(200).json({
    status: "success",
    data: { workspace },
  });
});

const patchWorkspace = asyncHandler(async (req, res) => {
  const workspace = await settingsService.updateWorkspaceSettings(req.body);
  res.status(200).json({
    status: "success",
    data: { workspace },
  });
});

const checkWorkspaceUrl = asyncHandler(async (req, res) => {
  const result = await settingsService.checkWorkspaceUrl(req.query.url);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

// Profile
const getProfile = asyncHandler(async (req, res) => {
  const profile = await settingsService.getUserProfile(req.user.id);
  res.status(200).json({
    status: "success",
    data: { profile },
  });
});

const patchProfile = asyncHandler(async (req, res) => {
  const profile = await settingsService.updateUserProfile(req.user.id, req.body);
  res.status(200).json({
    status: "success",
    data: { profile },
  });
});

const uploadAvatar = asyncHandler(async (req, res) => {
  const result = await settingsService.uploadAvatar(req.user.id, req.body.avatar);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

const changePassword = asyncHandler(async (req, res) => {
  const result = await settingsService.changePassword(req.user.id, req.body);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

const get2fa = asyncHandler(async (req, res) => {
  const result = await settingsService.get2faStatus(req.user.id);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

const patch2fa = asyncHandler(async (req, res) => {
  const result = await settingsService.update2faStatus(req.user.id, req.body);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

// Sessions
const getSessions = asyncHandler(async (req, res) => {
  const result = await settingsService.getUserSessions(
    req.user.id,
    req.sessionID,
    req
  );
  res.status(200).json({
    status: "success",
    data: result,
  });
});

const revokeOtherSessions = asyncHandler(async (req, res) => {
  const result = await settingsService.revokeOtherSessions(
    req.user.id,
    req.sessionID
  );
  res.status(200).json({
    status: "success",
    data: result,
  });
});

// Team
const getTeam = asyncHandler(async (_req, res) => {
  const team = await settingsService.getTeamSettings();
  res.status(200).json({
    status: "success",
    data: { team },
  });
});

const patchTeam = asyncHandler(async (req, res) => {
  const team = await settingsService.updateTeamSettings(req.body);
  res.status(200).json({
    status: "success",
    data: { team },
  });
});

// Notifications
const getNotifications = asyncHandler(async (req, res) => {
  const notifications = await settingsService.getNotificationSettings(req.user.id);
  res.status(200).json({
    status: "success",
    data: { notifications },
  });
});

const patchNotifications = asyncHandler(async (req, res) => {
  const notifications = await settingsService.updateNotificationSettings(
    req.user.id,
    req.body
  );
  res.status(200).json({
    status: "success",
    data: { notifications },
  });
});

// AI
const getAi = asyncHandler(async (_req, res) => {
  const ai = await settingsService.getAiSettings();
  res.status(200).json({
    status: "success",
    data: { ai },
  });
});

const patchAi = asyncHandler(async (req, res) => {
  const ai = await settingsService.updateAiSettings(req.body);
  res.status(200).json({
    status: "success",
    data: { ai },
  });
});

const getAiPreview = asyncHandler(async (req, res) => {
  const preview = settingsService.getAiPreview(req.query.tone);
  res.status(200).json({
    status: "success",
    data: { preview },
  });
});

export default {
  getWorkspace,
  patchWorkspace,
  checkWorkspaceUrl,
  getProfile,
  patchProfile,
  uploadAvatar,
  changePassword,
  get2fa,
  patch2fa,
  getSessions,
  revokeOtherSessions,
  getTeam,
  patchTeam,
  getNotifications,
  patchNotifications,
  getAi,
  patchAi,
  getAiPreview,
};

