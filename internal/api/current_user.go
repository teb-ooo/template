// The one operation the template ships. It is not an example resource: it keeps the OpenAPI document non-empty, which
// the playground-owned contract tests (TestContractAuth) require, and it shows the minimum of an operation (Security,
// auth.Require first). The schema starts empty; add the app's first resource next to this file and delete this one
// once the app has an operation of its own (see the worked example in the platform docs).
package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/teb-ooo/playground-go/auth"
)

func init() { registrations = append(registrations, registerCurrentUser) }

type currentUserOutput struct {
	Body struct {
		Subject  string `json:"subject" doc:"Stable identity subject."`
		Email    string `json:"email" doc:"Email address."`
		Username string `json:"username" doc:"Username."`
	}
}

func registerCurrentUser(d *Deps) {
	huma.Register(d.API, huma.Operation{
		OperationID: "get-current-user",
		Method:      http.MethodGet,
		Path:        "/api/me",
		Summary:     "Get the current user",
		Description: "Returns the signed-in user, or 401 when there is no session or token.",
		Tags:        []string{"session"},
		Security:    []map[string][]string{{"session": {}}, {"bearer": {}}},
	}, func(ctx context.Context, _ *struct{}) (*currentUserOutput, error) {
		u, err := auth.Require(ctx)
		if err != nil {
			return nil, err
		}
		out := &currentUserOutput{}
		out.Body.Subject, out.Body.Email, out.Body.Username = u.Subject, u.Email, u.Username
		return out, nil
	})
}
