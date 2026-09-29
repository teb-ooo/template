-- name: ListItems :many
SELECT id, name, created_at, updated_at FROM items ORDER BY created_at DESC, id DESC;

-- name: GetItem :one
SELECT id, name, created_at, updated_at FROM items WHERE id = $1;

-- name: CreateItem :one
INSERT INTO items (id, name) VALUES ($1, $2)
RETURNING id, name, created_at, updated_at;
