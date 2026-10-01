-- +goose Up
-- Keeps updated_at current on every update (DAT-7). Every table calls it from a trigger:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- internal/api/contract_schema_test.go fails a table that lacks the trigger.
-- +goose StatementBegin
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- Example resource; the agent deletes it (with internal/api/items.go) when real work starts.
CREATE TABLE items (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER items_set_updated_at BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE items;
DROP FUNCTION set_updated_at();
