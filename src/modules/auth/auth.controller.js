import authService from "./auth.service.js";
import asyncHandler from "../../utils/asyncHandler.js";
import ApiError from "../../utils/ApiError.js";
import env from "../../config/env.js";

/**
 * POST /api/v1/auth/register
 *
 * Request body (validated upstream by the `validate` middleware):
 *   { name: string, email: string, password: string }
 *
 * Response 201:
 *   { status: "success", data: { user: { id, name, email, role, created_at } } }
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  const user = await authService.registerUser({ name, email, password });

  res.status(201).json({
    status: "success",
    data: { user },
  });
});

/**
 * POST /api/v1/auth/login
 *
 * Request body (validated upstream by the `validate` middleware):
 *   { email: string, password: string }
 *
 * On success:
 *  1. Verifies credentials against the database.
 *  2. Regenerates the session ID to prevent session fixation.
 *  3. Stores only { userId, role } in the session — never the password.
 *  4. Returns the safe user profile.
 *
 * Response 200:
 *   { status: "success", data: { user: { id, name, email, role } } }
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await authService.loginUser({ email, password });

  // Regenerate session ID before writing anything to it.
  // This prevents session fixation: an attacker who set a session cookie
  // before login cannot use that same cookie after authentication.
  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

  // Store only minimal identity data — never the password or its hash.
  req.session.userId = user.id;
  req.session.role = user.role;

  // Persist the session before sending the response so the cookie is always
  // backed by a stored session when the client receives it.
  await new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });

  res.status(200).json({
    status: "success",
    data: { user },
  });
});

/**
 * GET /api/v1/auth/me
 *
 * Returns the authenticated user's safe profile.
 * Requires the `authenticate` middleware to run first (sets `req.user`).
 *
 * Response 200:
 *   { status: "success", data: { user: { id, name, email, role, created_at } } }
 */
const me = asyncHandler(async (req, res) => {
  // req.user is populated by the authenticate middleware
  const user = req.user.created_at
    ? req.user
    : await authService.getUserById(req.user.id);

  res.status(200).json({
    status: "success",
    data: { user },
  });
});

/**
 * POST /api/v1/auth/logout
 *
 * Destroys the server-side session and clears the session cookie.
 * The cookie options (name, path, sameSite, secure) must mirror those used
 * when the cookie was originally set (in session.js) so the browser removes it.
 *
 * Safe to call on an already-logged-out session (idempotent).
 *
 * Response 200:
 *   { status: "success", message: "Logged out successfully." }
 */
const logout = asyncHandler(async (req, res) => {
  if (!req.session) {
    // No session at all — already logged out
    return res
      .status(200)
      .json({ status: "success", message: "Logged out successfully." });
  }

  await new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(new ApiError(500, "Could not end your session. Please try again.")) : resolve()));
  });

  // Clear the cookie on the client side. Mirror name, path, and secure from session config.
  res.clearCookie("helpdesk.sid", {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: "lax",
    path: "/",
  });

  res.status(200).json({
    status: "success",
    message: "Logged out successfully.",
  });
});

export default { register, login, me, logout };
