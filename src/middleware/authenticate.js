import database from "../config/database.js";
import ApiError from "../utils/ApiError.js";

/**
 * Session-based authentication middleware.
 *
 * Reads `req.session.userId` (set by the login handler after session
 * regeneration). Loads the full user record from the database on every
 * request so that role changes, deactivation, or deletion are reflected
 * immediately without waiting for the session to expire.
 *
 * Never trusts a client-supplied role: the role is always fetched fresh
 * from the database.
 *
 * Sets `req.user` to:
 *   { id: string, name: string, email: string, role: string }
 *
 * Returns 401 when:
 *  - There is no active session / no userId stored in the session.
 *  - The session references a user that no longer exists.
 *  - The referenced user account is deactivated.
 */
async function authenticate(req, _res, next) {
  try {
    const userId = req.session?.userId;

    if (!userId) {
      return next(
        new ApiError(
          401,
          "Authentication required. Please log in.",
        ),
      );
    }

    const { rows } = await database.query(
      "SELECT id, name, email, role, is_active FROM users WHERE id = $1",
      [userId],
    );

    if (rows.length === 0) {
      // User deleted after session was created — destroy the stale session
      req.session.destroy(() => {});
      return next(new ApiError(401, "Authentication required. Please log in."));
    }

    const user = rows[0];

    if (!user.is_active) {
      req.session.destroy(() => {});
      return next(new ApiError(401, "Your account has been deactivated."));
    }

    // Attach verified user from DB — role is never client-supplied
    req.user = {
      id: String(user.id),
      name: user.name,
      email: user.email,
      role: user.role, // Already stored as uppercase in the DB (CUSTOMER/AGENT/ADMIN)
    };

    next();
  } catch (error) {
    next(error);
  }
}

export default authenticate;
