package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestPrintSpecNeedsNoEnvironment(t *testing.T) {
	for _, k := range []string{"DATABASE_URL", "SESSION_KEY", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "PUBLIC_URL", "APP_ENV"} {
		t.Setenv(k, "")
	}
	t.Setenv("APP_NAME", "sample")
	var out bytes.Buffer
	if err := printSpec(&out); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Info  struct{ Title string } `json:"info"`
		Paths map[string]any         `json:"paths"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	if doc.Info.Title != "sample" || doc.Paths["/api/items"] == nil {
		t.Fatalf("unexpected document: %+v", doc)
	}
}
