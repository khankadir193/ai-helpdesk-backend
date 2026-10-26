-- Up Migration

-- 1. users
CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'CUSTOMER',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_role_check CHECK (role IN ('CUSTOMER', 'AGENT', 'ADMIN')),
    CONSTRAINT users_name_not_blank CHECK (length(trim(name)) > 0),
    CONSTRAINT users_email_not_blank CHECK (length(trim(email)) > 0)
);

CREATE UNIQUE INDEX users_email_unique_ci ON users (lower(email));

-- 2. categories
CREATE TABLE categories (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    description VARCHAR(500),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT categories_name_key UNIQUE (name),
    CONSTRAINT categories_name_not_blank CHECK (length(trim(name)) > 0)
);

-- 3. tickets
CREATE TABLE tickets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    customer_id BIGINT NOT NULL,
    assigned_agent_id BIGINT,
    category_id BIGINT,
    priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tickets_customer_fk FOREIGN KEY (customer_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT tickets_assigned_agent_fk FOREIGN KEY (assigned_agent_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT tickets_category_fk FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
    CONSTRAINT tickets_priority_check CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    CONSTRAINT tickets_status_check CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
    CONSTRAINT tickets_title_not_blank CHECK (length(trim(title)) > 0),
    CONSTRAINT tickets_description_not_blank CHECK (length(trim(description)) > 0),
    CONSTRAINT tickets_resolved_status_consistency CHECK ((status NOT IN ('RESOLVED', 'CLOSED')) OR (resolved_at IS NOT NULL)),
    CONSTRAINT tickets_closed_status_consistency CHECK ((status <> 'CLOSED') OR (closed_at IS NOT NULL))
);

-- 4. ticket_comments
CREATE TABLE ticket_comments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL,
    author_id BIGINT NOT NULL,
    message TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ticket_comments_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_comments_author_fk FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_comments_message_not_blank CHECK (length(trim(message)) > 0)
);

-- 5. ticket_history
CREATE TABLE ticket_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL,
    changed_by BIGINT,
    action VARCHAR(40) NOT NULL,
    field_name VARCHAR(50),
    old_value JSONB,
    new_value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ticket_history_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_history_changed_by_fk FOREIGN KEY (changed_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ticket_history_action_not_blank CHECK (length(trim(action)) > 0)
);

-- 6. ai_suggestions
CREATE TABLE ai_suggestions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id BIGINT NOT NULL,
    requested_by BIGINT,
    suggestion_type VARCHAR(30) NOT NULL,
    result JSONB NOT NULL,
    provider VARCHAR(80) NOT NULL,
    model_name VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ai_suggestions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE RESTRICT,
    CONSTRAINT ai_suggestions_requested_by_fk FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ai_suggestions_reviewed_by_fk FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT ai_suggestions_suggestion_type_check CHECK (suggestion_type IN ('CLASSIFICATION', 'SUMMARY', 'REPLY_DRAFT')),
    CONSTRAINT ai_suggestions_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
    CONSTRAINT ai_suggestions_result_object CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT ai_suggestions_review_consistency CHECK (
        (status = 'PENDING' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR
        (status IN ('ACCEPTED', 'REJECTED') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    )
);

-- Down Migration

DROP TABLE IF EXISTS ai_suggestions CASCADE;
DROP TABLE IF EXISTS ticket_history CASCADE;
DROP TABLE IF EXISTS ticket_comments CASCADE;
DROP TABLE IF EXISTS tickets CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS users CASCADE;