# Policy install (D-41, research Decision 6): the install script keeps the static per-application secrets (oauth2-proxy client and cookie
# secrets, hub key files, the Keycloak administrator bootstrap, the Postgres password) under kv/apps/ and copies them into Kubernetes Secrets.
# Only those paths: per-person secrets are never injected into pods, and this token cannot reach kv/data/users/.
path "kv/data/apps/*" {
  capabilities = ["create", "read", "update"]
}
