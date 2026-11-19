/**
 * Database migration: Create notifications table and seed initial notification records.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
      title VARCHAR(255) NOT NULL,
      subtitle TEXT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT notification_title_not_blank CHECK (length(trim(title)) > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
  `);

  // Seed initial notification records for admin, agent, customer
  pgm.sql(`
    -- Seed for Admin
    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           (SELECT id FROM tickets WHERE priority = 'URGENT' LIMIT 1),
           'TCK-2044 was marked Urgent',
           'API returns 502 on /v1/tickets',
           FALSE,
           now() - interval '4 minutes'
    FROM users u
    WHERE u.email = 'admin@example.com' OR (u.role = 'ADMIN' AND u.id = 1255);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           (SELECT id FROM tickets WHERE id <> (SELECT id FROM tickets WHERE priority = 'URGENT' LIMIT 1) LIMIT 1),
           'Liam Park mentioned you in an internal note',
           'TCK-2047 · Cannot reset password',
           FALSE,
           now() - interval '18 minutes'
    FROM users u
    WHERE u.email = 'admin@example.com' OR (u.role = 'ADMIN' AND u.id = 1255);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           NULL,
           'AI flagged negative sentiment',
           'TCK-2048 · Duplicate charge on Pro',
           TRUE,
           now() - interval '1 hour'
    FROM users u
    WHERE u.email = 'admin@example.com' OR (u.role = 'ADMIN' AND u.id = 1255);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           NULL,
           'Weekly support report is ready',
           'Oct 19 – Oct 25',
           TRUE,
           now() - interval '3 hours'
    FROM users u
    WHERE u.email = 'admin@example.com' OR (u.role = 'ADMIN' AND u.id = 1255);

    -- Seed for Agent
    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           (SELECT id FROM tickets WHERE assigned_agent_id = u.id LIMIT 1),
           'TCK-2044 was assigned to you',
           'API returns 502 on /v1/tickets',
           FALSE,
           now() - interval '10 minutes'
    FROM users u
    WHERE u.email = 'agent@example.com' OR (u.role = 'AGENT' AND u.id = 1256);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           NULL,
           'New customer reply on TCK-2047',
           'Cannot reset password - email never arrives',
           FALSE,
           now() - interval '25 minutes'
    FROM users u
    WHERE u.email = 'agent@example.com' OR (u.role = 'AGENT' AND u.id = 1256);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           NULL,
           'AI drafted a response for TCK-2041',
           'Invoice needs VAT number updated',
           TRUE,
           now() - interval '2 hours'
    FROM users u
    WHERE u.email = 'agent@example.com' OR (u.role = 'AGENT' AND u.id = 1256);

    -- Seed for Customer
    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           (SELECT id FROM tickets WHERE customer_id = u.id LIMIT 1),
           'Your ticket TCK-2047 was updated',
           'An agent replied to your request',
           FALSE,
           now() - interval '15 minutes'
    FROM users u
    WHERE u.email = 'customer@example.com' OR (u.role = 'CUSTOMER' AND u.id = 1);

    INSERT INTO notifications (user_id, ticket_id, title, subtitle, is_read, created_at)
    SELECT u.id,
           NULL,
           'Ticket TCK-2041 was resolved',
           'Invoice needs VAT number updated',
           TRUE,
           now() - interval '1 day'
    FROM users u
    WHERE u.email = 'customer@example.com' OR (u.role = 'CUSTOMER' AND u.id = 1);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS notifications CASCADE;
  `);
};
