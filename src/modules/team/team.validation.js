/**
 * Validation schemas and input helpers for the Team module.
 */
import ApiError from "../../utils/ApiError.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const VALID_ROLES = ["ADMIN", "MANAGER", "AGENT"];

/**
 * Validate email string format.
 */
export function validateEmail(email) {
  if (!email || typeof email !== "string") {
    throw new ApiError(400, "Work email is required.");
  }
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed)) {
    throw new ApiError(400, "Please enter a valid work email address.");
  }
  return trimmed;
}

/**
 * Validate invitation creation payload.
 */
export function validateInvitePayload(body) {
  const email = validateEmail(body.email);

  const role = body.role ? String(body.role).toUpperCase().trim() : "AGENT";
  if (!VALID_ROLES.includes(role)) {
    throw new ApiError(400, "Invalid role selected. Must be Admin, Manager, or Support Agent.");
  }

  const team = body.team ? String(body.team).trim() : "General support";
  if (!team || team.length > 100) {
    throw new ApiError(400, "Team name is required and must be under 100 characters.");
  }

  return { email, role, team };
}

/**
 * Validate request-access change payload.
 */
export function validateRequestChangePayload(body) {
  if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length < 5) {
    throw new ApiError(400, "Please provide a reason with at least 5 characters explaining your access request.");
  }
  const requestedRole = body.requested_role ? String(body.requested_role).toUpperCase().trim() : "ADMIN";
  return {
    reason: body.reason.trim(),
    requested_role: requestedRole,
  };
}

/**
 * Validate roles matrix update payload.
 */
export function validateUpdateRolesPayload(body) {
  if (!body.permissions || !Array.isArray(body.permissions)) {
    throw new ApiError(400, "Permissions array is required.");
  }

  const sanitized = body.permissions.map((p) => {
    if (!p.id || typeof p.id !== "string") {
      throw new ApiError(400, "Each permission must have a valid string id.");
    }
    return {
      id: p.id.trim(),
      admin_value: p.values?.ADMIN || p.admin_value || "Allowed",
      manager_value: p.values?.MANAGER || p.manager_value || "Not allowed",
      agent_value: p.values?.AGENT || p.agent_value || "Not allowed",
    };
  });

  return sanitized;
}
