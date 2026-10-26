import database from "../config/database.js";
import ApiError from "../utils/ApiError.js";

/**
 * Authentication middleware that verifies credentials against the database.
 * Never trusts a client-supplied role.
 *
 * Supports:
 * - Authorization: Bearer <userId>
 * - x-user-id: <userId>
 */
async function authenticate(req, _res, next) {
  try {
    let rawUserId = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      rawUserId = authHeader.slice(7).trim();
    } else if (req.headers["x-user-id"]) {
      rawUserId = String(req.headers["x-user-id"]).trim();
    }

    if (!rawUserId) {
      return next(
        new ApiError(401, "Authentication required. Please provide valid credentials.")
      );
    }

    if (!/^[1-9]\d*$/.test(rawUserId)) {
      return next(new ApiError(401, "Invalid authentication credentials."));
    }

    const { rows } = await database.query(
      "SELECT id, name, email, role, is_active FROM users WHERE id = $1",
      [rawUserId]
    );

    if (rows.length === 0) {
      return next(new ApiError(401, "User not found or credentials invalid."));
    }

    const user = rows[0];

    if (!user.is_active) {
      return next(new ApiError(401, "User account is deactivated."));
    }

    // Attach verified user with role loaded strictly from database
    req.user = {
      id: String(user.id),
      name: user.name,
      email: user.email,
      role: String(user.role).toUpperCase(),
    };

    next();
  } catch (error) {
    next(error);
  }
}

export default authenticate;
