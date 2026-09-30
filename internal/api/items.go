package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/teb-ooo/playground-go/auth"

	"app/internal/db"
)

func init() { registrations = append(registrations, registerItems) }

// Item is the API shape of an item.
type Item struct {
	ID        uuid.UUID `json:"id" doc:"Item id (UUIDv7)."`
	Name      string    `json:"name" doc:"Display name."`
	CreatedAt time.Time `json:"created_at" doc:"Creation time, RFC 3339 UTC."`
	UpdatedAt time.Time `json:"updated_at" doc:"Last update time, RFC 3339 UTC."`
}

func toItem(i db.Item) Item {
	return Item{ID: i.ID, Name: i.Name, CreatedAt: i.CreatedAt.UTC(), UpdatedAt: i.UpdatedAt.UTC()}
}

type listItemsOutput struct {
	Body struct {
		Items []Item `json:"items" doc:"Items, newest first."`
	}
}

type createItemInput struct {
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"200" doc:"Display name, 1 to 200 characters."`
	}
}

type itemOutput struct {
	Body Item
}

type getItemInput struct {
	ID uuid.UUID `path:"id" doc:"Item id (UUIDv7)."`
}

func registerItems(d *Deps) {
	security := []map[string][]string{{"session": {}}, {"bearer": {}}}
	h := &itemsHandler{q: d.Q}

	huma.Register(d.API, huma.Operation{
		OperationID: "list-items",
		Method:      http.MethodGet,
		Path:        "/api/items",
		Summary:     "List items",
		Description: "Returns every item, newest first.",
		Tags:        []string{"items"},
		Security:    security,
	}, h.list)

	huma.Register(d.API, huma.Operation{
		OperationID:   "create-item",
		Method:        http.MethodPost,
		Path:          "/api/items",
		Summary:       "Create an item",
		Description:   "Creates an item with the given name and returns it.",
		Tags:          []string{"items"},
		Security:      security,
		DefaultStatus: http.StatusCreated,
	}, h.create)

	huma.Register(d.API, huma.Operation{
		OperationID: "get-item",
		Method:      http.MethodGet,
		Path:        "/api/items/{id}",
		Summary:     "Get an item",
		Description: "Returns one item by id, or 404 when it does not exist.",
		Tags:        []string{"items"},
		Security:    security,
	}, h.get)
}

type itemsHandler struct{ q *db.Queries }

func (h *itemsHandler) list(ctx context.Context, _ *struct{}) (*listItemsOutput, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	rows, err := h.q.ListItems(ctx)
	if err != nil {
		return nil, internalError(ctx, "list items", err)
	}
	out := &listItemsOutput{}
	out.Body.Items = make([]Item, 0, len(rows))
	for _, r := range rows {
		out.Body.Items = append(out.Body.Items, toItem(r))
	}
	return out, nil
}

func (h *itemsHandler) create(ctx context.Context, in *createItemInput) (*itemOutput, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError(ctx, "generate id", err)
	}
	row, err := h.q.CreateItem(ctx, db.CreateItemParams{ID: id, Name: in.Body.Name})
	if err != nil {
		return nil, internalError(ctx, "create item", err)
	}
	return &itemOutput{Body: toItem(row)}, nil
}

func (h *itemsHandler) get(ctx context.Context, in *getItemInput) (*itemOutput, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	row, err := h.q.GetItem(ctx, in.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("item not found")
	}
	if err != nil {
		return nil, internalError(ctx, "get item", err)
	}
	return &itemOutput{Body: toItem(row)}, nil
}
