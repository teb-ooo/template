# Common tasks. In the staging container use `factory-app restart` to rebuild and restart.
.PHONY: gen test build web run

gen:            ## regenerate database code and API types
	sqlc generate -f internal/db/sqlc.yaml
	cd web && npm run gen:api

test:           ## go vet + go test + web unit tests
	go vet ./... && go test ./...
	cd web && npm test --if-present

web:
	cd web && npm ci && npm run build

build: web
	CGO_ENABLED=0 go build -o bin/server ./cmd/server

run: build
	./bin/server
