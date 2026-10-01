-- +goose Up
-- The tables playground-go's assistant.PgxStore persists conversations in, scoped to the user.
-- IDs are UUIDv7, so ordering by id is ordering by time.
CREATE TABLE assistant_conversations (
    id         uuid PRIMARY KEY,
    user_id    text NOT NULL,
    title      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_conversations_user_idx
    ON assistant_conversations (user_id, updated_at DESC);

CREATE TABLE assistant_messages (
    id              uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES assistant_conversations (id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('user', 'assistant')),
    content         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_messages_conversation_idx
    ON assistant_messages (conversation_id, id);

-- DAT-7: every table keeps updated_at current (set_updated_at() comes from the app's first migration).
CREATE TRIGGER assistant_conversations_set_updated_at BEFORE UPDATE ON assistant_conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER assistant_messages_set_updated_at BEFORE UPDATE ON assistant_messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE assistant_messages;
DROP TABLE assistant_conversations;
