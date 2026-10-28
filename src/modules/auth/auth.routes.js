import express from "express";
import { rateLimit } from "express-rate-limit";
import validate from "../../middleware/validate.js";
import authenticate from "../../middleware/authenticate.js";
import authController from "./auth.controller.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Apply a strict rate limit to login and registration to slow down brute-force
 * and credential-stuffing attacks.
 *
 * Allows 10 attempts per IP per 15 minutes for auth endpoints.
 * The window and limit are deliberately conservative; adjust for your traffic.
 */
/**
 * Determine whether we are running in production.
 * dotenv has already loaded at this point (env.js imports dotenv/config),
 * so process.env.NODE_ENV reflects the value from .env (or the OS environment
 * if NODE_ENV was set before dotenv ran — dotenv does NOT overwrite pre-set vars).
 */
const isProduction = process.env.NODE_ENV === "production";

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // In production: strict limit to slow brute-force attacks.
  // In development/test: permissive limit so tests don't hit the ceiling.
  limit: isProduction ? 10 : 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    status: "error",
    message:
      "Too many requests from this IP, please try again after 15 minutes.",
  },
  skipSuccessfulRequests: false,
});

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /register.
 *
 * Constraints:
 *  - name    : 1–100 chars (VARCHAR(100) in DB). Whitespace-only is rejected.
 *  - email   : basic RFC-5322-ish format check; max 254 chars (RFC 5321 limit)
 *  - password: 8–72 chars (72 is bcrypt's effective input limit)
 *
 * Privileged roles are NOT accepted as input — role is always defaulted to
 * 'CUSTOMER' inside the DB DEFAULT and the service layer.
 */
const registerSchema = {
  name: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 100,
  },
  email: {
    type: "string",
    required: true,
    maxLength: 254,
    // Minimal sanity check: something@something.something
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: "email must be a valid email address",
  },
  password: {
    type: "string",
    required: true,
    minLength: 8,
    // 72 bytes is bcrypt's hard input limit; cap at 72 chars (ASCII-safe limit)
    maxLength: 72,
    maxLengthMessage: "password must be at most 72 characters (bcrypt limit)",
  },
};

/**
 * Schema for POST /login.
 *
 * We intentionally do NOT enforce password complexity here to avoid leaking
 * whether a given password format could ever be valid for this account.
 * The service layer will reject bad credentials with a generic message.
 */
const loginSchema = {
  email: {
    type: "string",
    required: true,
    maxLength: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: "email must be a valid email address",
  },
  password: {
    type: "string",
    required: true,
    minLength: 1,
    maxLength: 72,
  },
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** POST /api/v1/auth/register */
router.post(
  "/register",
  authRateLimit,
  validate(registerSchema),
  authController.register,
);

/** POST /api/v1/auth/login */
router.post(
  "/login",
  authRateLimit,
  validate(loginSchema),
  authController.login,
);

/**
 * GET /api/v1/auth/me
 * Returns the currently authenticated user's safe profile.
 * Requires a valid session cookie.
 */
router.get("/me", authenticate, authController.me);

/**
 * POST /api/v1/auth/logout
 * Destroys the server-side session and clears the session cookie.
 * Requires a valid session; returns 200 even if already logged out.
 */
router.post("/logout", authController.logout);

export default router;
