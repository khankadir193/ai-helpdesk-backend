/**
 * Roles & permissions fix: persistent, role-scoped permissions for exactly
 * three roles (ADMIN / AGENT / CUSTOMER).
 *
 * 1. Removes the MANAGER role remnants (the role is not supported anywhere in
 *    the code). Any MANAGER account is mapped to AGENT (fail-closed), then the
 *    users.role CHECK constraint is restored to the three canonical roles.
 * 2. Adds the missing `customer_value` column so CUSTOMER permissions are
 *    persisted instead of being hardcoded to static defaults.
 * 3. Drops legacy permission rows whose ids are no longer part of the
 *    canonical matrix (view_reply_tickets, delete_tickets, deactivate_members).
 * 4. Normalizes the matrix rows to the canonical 13 permissions and their
 *    default values, including the ADMIN column lock values. The matrix was
 *    previously not editable from the UI (write path was never wired), so no
 *    admin-made customizations exist to preserve.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // 1. Remove the MANAGER role (map any account to AGENT — fail closed).
  pgm.sql(`
    UPDATE users SET role = 'AGENT', updated_at = now() WHERE role = 'MANAGER';
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'AGENT', 'ADMIN'));
  `);

  // 2. Persist CUSTOMER permissions.
  pgm.sql(`
    ALTER TABLE team_role_permissions
      ADD COLUMN IF NOT EXISTS customer_value VARCHAR(100) NOT NULL DEFAULT 'Not allowed';
  `);

  // 3. Remove legacy permission rows that are no longer part of the matrix.
  pgm.sql(`
    DELETE FROM team_role_permissions
    WHERE permission_id IN ('view_reply_tickets', 'delete_tickets', 'deactivate_members');
  `);

  // 4. Normalize the matrix to the canonical catalogue + defaults.
  //    manager_value stays NOT NULL for schema compatibility but is now dead
  //    weight (the MANAGER role no longer exists); it is reset to a neutral
  //    value and never read.
  pgm.sql(`
    INSERT INTO team_role_permissions
      (permission_id, admin_value, manager_value, agent_value, customer_value, updated_at)
    VALUES
      ('create_tickets',           'Not allowed',   'Not allowed', 'Not allowed',      'Allowed',        now()),
      ('view_tickets',             'All tickets',   'Not allowed', 'Assigned tickets', 'Own tickets',    now()),
      ('reply_tickets',            'All tickets',   'Not allowed', 'Assigned tickets', 'Own tickets',    now()),
      ('internal_notes',           'Allowed',       'Not allowed', 'Allowed',          'Not allowed',    now()),
      ('update_status',            'All tickets',   'Not allowed', 'Assigned tickets', 'Not allowed',    now()),
      ('assign_reassign_tickets',  'Allowed',       'Not allowed', 'Not allowed',      'Not allowed',    now()),
      ('ticket_history',           'All tickets',   'Not allowed', 'Assigned tickets', 'Not allowed',    now()),
      ('ai_tools',                 'All tickets',   'Not allowed', 'Assigned tickets', 'Not allowed',    now()),
      ('publish_kb',               'Publish & edit','Not allowed', 'Publish & edit',   'View only',      now()),
      ('view_reports',             'Workspace',     'Not allowed', 'Own performance',  'Not allowed',    now()),
      ('invite_members',           'Allowed',       'Not allowed', 'Not allowed',      'Not allowed',    now()),
      ('edit_roles_permissions',   'Allowed',       'Not allowed', 'View only',        'Not allowed',    now()),
      ('billing_security_settings','Allowed',       'Not allowed', 'Not allowed',      'Not allowed',    now())
    ON CONFLICT (permission_id) DO UPDATE SET
      admin_value = EXCLUDED.admin_value,
      manager_value = 'Not allowed',
      agent_value = EXCLUDED.agent_value,
      customer_value = EXCLUDED.customer_value,
      updated_at = now();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE team_role_permissions DROP COLUMN IF EXISTS customer_value;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'AGENT', 'ADMIN', 'MANAGER'));
  `);
};
