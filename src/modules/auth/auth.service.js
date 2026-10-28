import bcrypt from "bcrypt";
import database from "../../config/database.js";
import ApiError from "../../utils/ApiError.js";

/** bcrypt work factor — high enough for security, bounded to stay usable */
const BCRYPT_ROUNDS = 12;

/**
 * Normalise an email address: trim surrounding whitespace and lowercase.
 * @param {string} raw
 * @returns {string}
 */
function normaliseEmail(raw) {
  return raw.trim().toLowerCase();
}

/**
 * Register a new user account.
 *
 * Responsibilities:
 *  - Normalise email (trim + lowercase)
 *  - Pre-check for a duplicate email before hashing to avoid spending bcrypt
 *    work on a request that will be rejected
 *  - Hash the password with bcrypt (work factor 12)
 *  - Insert the user into PostgreSQL
 *  - Retain the DB unique-constraint catch (23505) as a safety net for the
 *    narrow race-condition window between the pre-check SELECT and the INSERT
 *  - Return only public fields; never expose password_hash
 *
 * @param {{ name: string, email: string, password: string }} data
 * @returns {Promise<{ id: string, name: string, email: string, role: string, created_at: Date }>}
 */
async function registerUser({ name, email, password }) {
  const normalisedEmail = normaliseEmail(email);

  // Pre-check: reject duplicate emails before paying the bcrypt cost.
  // Case-insensitive by design because emails are stored pre-normalised
  // (trimmed + lowercased) and the UNIQUE index covers lower(email).
  const { rows: existing } = await database.query(
    "SELECT 1 FROM users WHERE lower(email) = $1",
    [normalisedEmail],
  );

  if (existing.length > 0) {
    throw new ApiError(
      409,
      "Email already exists. Please use a different email.",
    );
  }

  // Hash with bcrypt; work factor of 12 is recommended for current hardware
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { rows } = await database.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, created_at`,
      [name.trim(), normalisedEmail, passwordHash],
    );

    return rows[0];
  } catch (error) {
    // PostgreSQL unique-violation error code: 23505
    // Safety net for the race-condition window between the pre-check SELECT
    // and this INSERT. Matches constraint name or detail.
    if (
      error.code === "23505" &&
      (error.constraint === "users_email_unique_ci" ||
        error.detail?.includes("email") ||
        error.constraint?.includes("email"))
    ) {
      throw new ApiError(
        409,
        "Email already exists. Please use a different email.",
      );
    }

    throw error;
  }
}

/**
 * Authenticate a user by email and password.
 *
 * Deliberately uses the same generic error message for both "no such user"
 * and "wrong password" to prevent user-enumeration attacks.
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<{ id: string, name: string, email: string, role: string }>}
 */
async function loginUser({ email, password }) {
  const normalisedEmail = normaliseEmail(email);

  const { rows } = await database.query(
    "SELECT id, name, email, role, password_hash, is_active FROM users WHERE lower(email) = $1",
    [normalisedEmail],
  );

  // Always compare even if user not found (prevents timing-based enumeration)
  const DUMMY_HASH =
    "$2b$12$invalidhashpaddingthatislong.enoughxxxxxxxxxxxxxxxxxxxxxx";
  const candidateHash = rows[0]?.password_hash ?? DUMMY_HASH;
  const passwordMatch = await bcrypt.compare(password, candidateHash);

  if (rows.length === 0 || !passwordMatch) {
    throw new ApiError(401, "Invalid email or password.");
  }

  const user = rows[0];

  if (!user.is_active) {
    throw new ApiError(401, "Your account has been deactivated.");
  }

  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

/**
 * Get the safe public profile of a user by ID.
 * Used by the /me endpoint after session authentication.
 *
 * @param {string|number} userId
 * @returns {Promise<{ id: string, name: string, email: string, role: string, created_at: Date }>}
 */
async function getUserById(userId) {
  const { rows } = await database.query(
    "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
    [userId],
  );

  if (rows.length === 0) {
    throw new ApiError(404, "User not found.");
  }

  const user = rows[0];
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
  };
}

export default { registerUser, loginUser, getUserById };
