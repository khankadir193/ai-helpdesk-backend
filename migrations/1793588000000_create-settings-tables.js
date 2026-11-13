/**
 * Database migration for Settings feature.
 * Creates workspace_settings, user_profiles, team_settings, user_notification_settings, and ai_settings.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // 1. workspace_settings
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id VARCHAR(50) NOT NULL DEFAULT 'ws_acme_001',
      name VARCHAR(100) NOT NULL DEFAULT 'Acme Support',
      url VARCHAR(120) NOT NULL DEFAULT 'acme.helpdesk.ai',
      support_email VARCHAR(255) NOT NULL DEFAULT 'support@acme.com',
      timezone VARCHAR(100) NOT NULL DEFAULT '(UTC-08:00) Pacific Time',
      language VARCHAR(100) NOT NULL DEFAULT 'English (United States)',
      owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT workspace_name_not_blank CHECK (length(trim(name)) > 0),
      CONSTRAINT workspace_url_not_blank CHECK (length(trim(url)) > 0),
      CONSTRAINT workspace_support_email_not_blank CHECK (length(trim(support_email)) > 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS workspace_settings_url_ci_unique ON workspace_settings (LOWER(url));
  `);

  // Seed default workspace if none exists
  pgm.sql(`
    INSERT INTO workspace_settings (workspace_id, name, url, support_email, timezone, language, owner_id)
    SELECT 'ws_acme_001', 'Acme Support', 'acme.helpdesk.ai', 'support@acme.com', '(UTC-08:00) Pacific Time', 'English (United States)',
           (SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1)
    WHERE NOT EXISTS (SELECT 1 FROM workspace_settings);
  `);

  // 2. user_profiles
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      job_title VARCHAR(120) NOT NULL DEFAULT 'Customer Support Manager',
      avatar_url TEXT,
      password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      two_factor_enabled BOOLEAN NOT NULL DEFAULT true,
      two_factor_secret VARCHAR(100) DEFAULT 'authenticator-app',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed user_profiles for existing users
  pgm.sql(`
    INSERT INTO user_profiles (user_id, job_title, password_changed_at, two_factor_enabled)
    SELECT id, 
           CASE 
             WHEN role = 'ADMIN' THEN 'Support Director'
             WHEN role = 'AGENT' THEN 'Customer Support Specialist'
             ELSE 'Customer Support Manager'
           END,
           now() - interval '32 days',
           true
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.user_id = u.id);
  `);

  // 3. team_settings
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS team_settings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      default_team VARCHAR(100) NOT NULL DEFAULT 'Customer Support',
      default_priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
      assignment_method VARCHAR(50) NOT NULL DEFAULT 'ROUND_ROBIN',
      fallback_action VARCHAR(50) NOT NULL DEFAULT 'UNASSIGNED_QUEUE',
      route_available_only BOOLEAN NOT NULL DEFAULT true,
      default_invitation_role VARCHAR(50) NOT NULL DEFAULT 'Support Agent',
      active_members_count INT NOT NULL DEFAULT 12,
      pending_invites_count INT NOT NULL DEFAULT 2,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed default team settings if none exists
  pgm.sql(`
    INSERT INTO team_settings (default_team, default_priority, assignment_method, fallback_action, route_available_only, default_invitation_role, active_members_count, pending_invites_count)
    SELECT 'Customer Support', 'MEDIUM', 'ROUND_ROBIN', 'UNASSIGNED_QUEUE', true, 'Support Agent', 12, 2
    WHERE NOT EXISTS (SELECT 1 FROM team_settings);
  `);

  // 4. user_notification_settings
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS user_notification_settings (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      in_app_enabled BOOLEAN NOT NULL DEFAULT true,
      email_enabled BOOLEAN NOT NULL DEFAULT true,
      desktop_enabled BOOLEAN NOT NULL DEFAULT false,
      email_digest VARCHAR(50) NOT NULL DEFAULT 'DAILY_8AM',
      quiet_hours_enabled BOOLEAN NOT NULL DEFAULT true,
      quiet_hours_start VARCHAR(10) NOT NULL DEFAULT '18:00',
      quiet_hours_end VARCHAR(10) NOT NULL DEFAULT '08:00',
      matrix JSONB NOT NULL DEFAULT '[
        {"id": "ticket_assigned", "label": "Ticket assigned to me", "description": "New assignments and reassignments", "in_app": true, "email": true},
        {"id": "customer_replies", "label": "Customer replies", "description": "Replies on tickets assigned to me", "in_app": true, "email": true},
        {"id": "mentions_notes", "label": "Mentions & internal notes", "description": "When a teammate mentions me", "in_app": true, "email": true},
        {"id": "urgent_sla", "label": "Urgent tickets & SLA risk", "description": "Time-sensitive alerts for my team", "in_app": true, "email": false},
        {"id": "ai_draft", "label": "AI draft ready for review", "description": "AI-labeled suggestions on my tickets", "in_app": true, "email": false}
      ]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // 5. ai_settings
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS ai_settings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      ai_enabled BOOLEAN NOT NULL DEFAULT true,
      redact_sensitive BOOLEAN NOT NULL DEFAULT true,
      default_tone VARCHAR(50) NOT NULL DEFAULT 'FRIENDLY_PROFESSIONAL',
      draft_mode VARCHAR(50) NOT NULL DEFAULT 'ON_REQUEST',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Seed default AI settings if none exists
  pgm.sql(`
    INSERT INTO ai_settings (ai_enabled, redact_sensitive, default_tone, draft_mode)
    SELECT true, true, 'FRIENDLY_PROFESSIONAL', 'ON_REQUEST'
    WHERE NOT EXISTS (SELECT 1 FROM ai_settings);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS ai_settings CASCADE;
    DROP TABLE IF EXISTS user_notification_settings CASCADE;
    DROP TABLE IF EXISTS team_settings CASCADE;
    DROP TABLE IF EXISTS user_profiles CASCADE;
    DROP TABLE IF EXISTS workspace_settings CASCADE;
  `);
};

