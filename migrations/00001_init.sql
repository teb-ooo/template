-- +goose Up
-- Keeps updated_at current on every update (DAT-7). Every table calls it from a trigger:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- internal/api/contract_schema_test.go fails a table that lacks the trigger.
-- The schema starts empty: the first resource's table goes in the next migration (00002_<name>.sql).
-- +goose StatementBegin
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION set_updated_at();
