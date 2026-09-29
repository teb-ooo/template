-- +goose Up
-- Example resource; the agent deletes it (with internal/api/items.go) when real work starts.
CREATE TABLE items (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE items;
