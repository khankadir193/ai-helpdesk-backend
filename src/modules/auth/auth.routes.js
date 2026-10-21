import express from "express";
import validate from "../../middleware/validate.js";
import authController from "./auth.controller.js";

const router = express.Router();

/**
 * Schema for POST /register.
 *
 * Constraints chosen to be sensible without being restrictive:
 *  - name    : 1–100 chars (VARCHAR(100) in DB)
 *  - email   : basic RFC-5322-ish format check; max 254 chars (RFC 5321 limit)
 *  - password: 8–72 chars (72 is bcrypt's effective input limit)
 *
 * Privileged roles are NOT accepted as input — role is always defaulted to
 * 'user' inside the service layer.
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
    maxLengthMessage:
      "password must be at most 72 characters (bcrypt limit)",
  },
};

router.post("/register", validate(registerSchema), authController.register);

export default router;
