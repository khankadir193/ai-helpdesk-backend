/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Lightweight enum for user roles; only 'user' is assigned at registration
  pgm.createType("user_role", ["user", "agent", "admin"]);

  pgm.createTable("users", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    name: {
      type: "varchar(100)",
      notNull: true,
    },
    // Stored pre-normalised (trimmed + lowercased); uniqueness enforced by index
    email: {
      type: "varchar(254)",
      notNull: true,
    },
    password_hash: {
      type: "varchar(72)",
      notNull: true,
    },
    role: {
      type: "user_role",
      notNull: true,
      default: "user",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  // Unique constraint on the normalised email column (also prevents race conditions)
  pgm.addConstraint("users", "users_email_unique", "UNIQUE (email)");

  // Index to accelerate email-based look-ups (login, duplicate check)
  pgm.createIndex("users", "email");
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable("users");
  pgm.dropType("user_role");
};
