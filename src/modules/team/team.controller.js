/**
 * Team Controller — Dispatches team API endpoints.
 */
import asyncHandler from "../../utils/asyncHandler.js";
import teamService from "./team.service.js";
import {
  validateInvitePayload,
  validateRequestChangePayload,
  validateUpdateRolesPayload,
} from "./team.validation.js";

const getPerformance = asyncHandler(async (req, res) => {
  const data = await teamService.getTeamPerformance(req.user, req.query);
  res.status(200).json({
    status: "success",
    data,
  });
});

const exportPerformanceCsv = asyncHandler(async (req, res) => {
  const csv = await teamService.exportTeamPerformanceCsv(req.user, req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="team-performance-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.status(200).send(csv);
});

const getRoles = asyncHandler(async (req, res) => {
  const data = await teamService.getRolesAndPermissions(req.user);
  res.status(200).json({
    status: "success",
    data,
  });
});

const patchRoles = asyncHandler(async (req, res) => {
  const sanitized = validateUpdateRolesPayload(req.body);
  const data = await teamService.updateRolesAndPermissions(req.user, sanitized);
  res.status(200).json({
    status: "success",
    data,
  });
});

const requestRoleChange = asyncHandler(async (req, res) => {
  const payload = validateRequestChangePayload(req.body);
  const data = await teamService.requestAccessChange(req.user, payload);
  res.status(200).json({
    status: "success",
    data,
  });
});

const getTeams = asyncHandler(async (_req, res) => {
  const teams = await teamService.getTeams();
  res.status(200).json({
    status: "success",
    data: { teams },
  });
});

const getInviteOptions = asyncHandler(async (req, res) => {
  const data = await teamService.getInviteOptions(req.user);
  res.status(200).json({
    status: "success",
    data,
  });
});

const createInvitation = asyncHandler(async (req, res) => {
  const payload = validateInvitePayload(req.body);
  const invitation = await teamService.createInvitation(req.user, payload);
  res.status(201).json({
    status: "success",
    data: { invitation },
  });
});

const listMembers = asyncHandler(async (req, res) => {
  const data = await teamService.listMembers(req.user);
  res.status(200).json({
    status: "success",
    data,
  });
});

const resendInvitation = asyncHandler(async (req, res) => {
  const invitation = await teamService.resendInvitation(req.user, req.params.id);
  res.status(200).json({
    status: "success",
    message: "Invitation resent successfully.",
    data: { invitation },
  });
});

const revokeInvitation = asyncHandler(async (req, res) => {
  const result = await teamService.revokeInvitation(req.user, req.params.id);
  res.status(200).json({
    status: "success",
    message: "Invitation revoked.",
    data: result,
  });
});

export default {
  getPerformance,
  exportPerformanceCsv,
  getRoles,
  patchRoles,
  requestRoleChange,
  getTeams,
  getInviteOptions,
  createInvitation,
  listMembers,
  resendInvitation,
  revokeInvitation,
};
