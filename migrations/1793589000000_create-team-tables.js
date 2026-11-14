/**
 * Database migration for Team feature.
 * Creates team_invitations, team_role_permissions, team_access_requests,
 * and updates users_role_check to support MANAGER role.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // 1. Update users_role_check to include MANAGER
  pgm.sql(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'AGENT', 'ADMIN', 'MANAGER'));
  `);

  // 2. team_invitations table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS team_invitations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'AGENT',
      team VARCHAR(100) NOT NULL DEFAULT 'General support',
      invited_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      token VARCHAR(100) UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT team_invitations_email_not_blank CHECK (length(trim(email)) > 0),
      CONSTRAINT team_invitations_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'))
    );

    CREATE INDEX IF NOT EXISTS team_invitations_email_ci ON team_invitations (LOWER(email));
    CREATE INDEX IF NOT EXISTS team_invitations_status_idx ON team_invitations (status);
  `);

  // 3. team_role_permissions table for customizable matrix
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS team_role_permissions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      permission_id VARCHAR(100) NOT NULL UNIQUE,
      admin_value VARCHAR(100) NOT NULL,
      manager_value VARCHAR(100) NOT NULL,
      agent_value VARCHAR(100) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 4. team_access_requests table
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS team_access_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      requested_role VARCHAR(50) NOT NULL DEFAULT 'ADMIN',
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT team_access_requests_reason_not_blank CHECK (length(trim(reason)) > 0)
    );
  `);

  // 5. Seed default permissions matrix matching the reference design
  pgm.sql(`
    INSERT INTO team_role_permissions (permission_id, admin_value, manager_value, agent_value)
    VALUES
      ('view_reply_tickets', 'All tickets', 'Team tickets', 'Assigned tickets'),
      ('assign_reassign_tickets', 'All teams', 'Own team', 'Self only'),
      ('delete_tickets', 'Allowed', 'Not allowed', 'Not allowed'),
      ('publish_kb', 'Allowed', 'Allowed', 'Draft only'),
      ('view_reports', 'Workspace', 'Own team', 'Own performance'),
      ('invite_members', 'Any role', 'Support Agent only', 'Not allowed'),
      ('deactivate_members', 'Allowed', 'Not allowed', 'Not allowed'),
      ('edit_roles_permissions', 'Allowed', 'Not allowed', 'Not allowed'),
      ('billing_security_settings', 'Allowed', 'Not allowed', 'Not allowed')
    ON CONFLICT (permission_id) DO NOTHING;
  `);

  // 6. Ensure default Alex Morgan Admin and Maya Chen Manager exist for reference fidelity
  pgm.sql(`
    UPDATE users SET name = 'Alex Morgan' WHERE email = 'admin@example.com';

    INSERT INTO users (name, email, password_hash, role, is_active)
    SELECT 'Maya Chen', 'manager@example.com', '$2b$12$4i5VzK8i7O5eF3B08kFveepQ7a1tH72z7cR9j1Vz1G1W9J9eP9K8u', 'MANAGER', true
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = 'manager@example.com');
  `);

  // 7. Seed 2 initial pending invitations matching team_settings
  pgm.sql(`
    INSERT INTO team_invitations (email, role, team, status, token, expires_at)
    SELECT 'sarah.jenkins@example.com', 'AGENT', 'Customer Support', 'PENDING', 'tok_init_001', now() + interval '5 days'
    WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE LOWER(email) = 'sarah.jenkins@example.com');

    INSERT INTO team_invitations (email, role, team, status, token, expires_at)
    SELECT 'marcus.vance@example.com', 'AGENT', 'Technical Support', 'PENDING', 'tok_init_002', now() + interval '6 days'
    WHERE NOT EXISTS (SELECT 1 FROM team_invitations WHERE LOWER(email) = 'marcus.vance@example.com');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS team_access_requests;
    DROP TABLE IF EXISTS team_role_permissions;
    DROP TABLE IF EXISTS team_invitations;
  `);
};
