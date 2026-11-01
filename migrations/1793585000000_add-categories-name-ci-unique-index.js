/**
 * Promotes the case-insensitive category name uniqueness that requirements
 * (NFR-D05, FR-041) and the category service pre-checks depend on into the
 * migration history. Previously this index was only created ad hoc by the
 * integration test suites, so a fresh database created with `npm run db:migrate`
 * would miss the index and rely exclusively on the application-level check,
 * leaving a race window for case-variant duplicates.
 *
 * Uses IF NOT EXISTS so databases where the index already exists (e.g. the
 * shared development database) are not disturbed.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(
    "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_unique_ci ON categories (LOWER(name))",
  );
};

/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS categories_name_unique_ci");
};
