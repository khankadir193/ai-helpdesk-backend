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
 *  - Hash the password with bcrypt (work factor 12)
 *  - Insert the user into PostgreSQL
 *  - Rely on the DB unique constraint on `email` to guard against race
 *    conditions (concurrent duplicate registrations)
 *  - Return only public fields; never expose password_hash
 *
 * @param {{ name: string, email: string, password: string }} data
 * @returns {Promise<{ id: string, name: string, email: string, role: string, created_at: Date }>}
 */
async function registerUser({ name, email, password }) {
  const normalisedEmail = normaliseEmail(email);

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
    // Relying on the DB constraint means this also catches race conditions
    // that a prior SELECT check would miss.
    if (error.code === "23505" && error.constraint === "users_email_unique") {
      throw new ApiError(409, "An account with that email already exists");
    }

    throw error;
  }
}

export default { registerUser };
