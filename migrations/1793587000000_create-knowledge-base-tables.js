/**
 * Database migration for Knowledge Base feature.
 * Creates kb_categories, kb_articles, kb_article_versions, and kb_article_feedback.
 *
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // 1. kb_categories
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS kb_categories (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      description VARCHAR(500),
      icon VARCHAR(50) NOT NULL DEFAULT 'book-open',
      display_order INT NOT NULL DEFAULT 0,
      owner_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT kb_categories_name_not_blank CHECK (length(trim(name)) > 0),
      CONSTRAINT kb_categories_slug_not_blank CHECK (length(trim(slug)) > 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS kb_categories_name_ci_unique ON kb_categories (LOWER(name));
    CREATE UNIQUE INDEX IF NOT EXISTS kb_categories_slug_ci_unique ON kb_categories (LOWER(slug));
    CREATE INDEX IF NOT EXISTS kb_categories_order_idx ON kb_categories (display_order ASC);
  `);

  // 2. kb_articles
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      article_id VARCHAR(20) NOT NULL,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      summary TEXT,
      content TEXT NOT NULL DEFAULT '',
      category_id BIGINT REFERENCES kb_categories(id) ON DELETE RESTRICT,
      author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
      visibility VARCHAR(30) NOT NULL DEFAULT 'PUBLIC',
      tags TEXT[] NOT NULL DEFAULT '{}',
      published_version INT NOT NULL DEFAULT 1,
      draft_version INT NOT NULL DEFAULT 1,
      draft_title VARCHAR(255),
      draft_summary TEXT,
      draft_content TEXT,
      has_draft_revision BOOLEAN NOT NULL DEFAULT false,
      draft_saved_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      view_count INT NOT NULL DEFAULT 0,
      helpful_yes INT NOT NULL DEFAULT 0,
      helpful_no INT NOT NULL DEFAULT 0,
      featured BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT kb_articles_article_id_not_blank CHECK (length(trim(article_id)) > 0),
      CONSTRAINT kb_articles_title_not_blank CHECK (length(trim(title)) > 0),
      CONSTRAINT kb_articles_slug_not_blank CHECK (length(trim(slug)) > 0),
      CONSTRAINT kb_articles_status_check CHECK (status IN ('PUBLISHED', 'DRAFT', 'IN_REVIEW', 'ARCHIVED')),
      CONSTRAINT kb_articles_visibility_check CHECK (visibility IN ('PUBLIC', 'INTERNAL'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS kb_articles_article_id_uq ON kb_articles (article_id);
    CREATE UNIQUE INDEX IF NOT EXISTS kb_articles_slug_ci_uq ON kb_articles (LOWER(slug));
    CREATE INDEX IF NOT EXISTS kb_articles_status_idx ON kb_articles (status);
    CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles (category_id);
    CREATE INDEX IF NOT EXISTS kb_articles_author_idx ON kb_articles (author_id);
    CREATE INDEX IF NOT EXISTS kb_articles_views_idx ON kb_articles (view_count DESC);
    CREATE INDEX IF NOT EXISTS kb_articles_updated_idx ON kb_articles (updated_at DESC);
  `);

  // 3. kb_article_versions
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS kb_article_versions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      article_id BIGINT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      version INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      summary TEXT,
      content TEXT NOT NULL,
      published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT kb_article_versions_uq UNIQUE (article_id, version)
    );

    CREATE INDEX IF NOT EXISTS kb_article_versions_article_idx ON kb_article_versions (article_id, version DESC);
  `);

  // 4. kb_article_feedback
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS kb_article_feedback (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      article_id BIGINT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      client_identifier VARCHAR(100) NOT NULL,
      is_helpful BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT kb_feedback_user_uq UNIQUE (article_id, client_identifier)
    );

    CREATE INDEX IF NOT EXISTS kb_feedback_article_idx ON kb_article_feedback (article_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS kb_article_feedback CASCADE;
    DROP TABLE IF EXISTS kb_article_versions CASCADE;
    DROP TABLE IF EXISTS kb_articles CASCADE;
    DROP TABLE IF EXISTS kb_categories CASCADE;
  `);
};

