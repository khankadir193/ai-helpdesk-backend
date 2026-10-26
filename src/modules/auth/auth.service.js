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
 * Note on ID gaps: the `id` column uses UUID (gen_random_uuid()), not a
 * SERIAL/IDENTITY sequence.  UUIDs are generated at insert time, so a failed
 * or rolled-back insert never consumes an ID — there are no sequence gaps.
 *
 * @param {{ name: string, email: string, password: string }} data
 * @returns {Promise<{ id: string, name: string, email: string, role: string, created_at: Date }>}
 */
async function registerUser({ name, email, password }) {
  const normalisedEmail = normaliseEmail(email);

  // Pre-check: reject duplicate emails before paying the bcrypt cost.
  // Case-insensitive by design because emails are stored pre-normalised
  // (trimmed + lowercased) and the UNIQUE constraint covers that column.
  const { rows: existing } = await database.query(
    "SELECT 1 FROM users WHERE email = $1",
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
    // and this INSERT.  We match on the column name from `detail` rather than
    // the constraint name (e.g. "users_email_key" vs "users_email_unique").
    if (error.code === "23505" && error.detail?.includes("(email)")) {
      throw new ApiError(
        409,
        "Email already exists. Please use a different email.",
      );
    }

    throw error;
  }
}

export default { registerUser };
