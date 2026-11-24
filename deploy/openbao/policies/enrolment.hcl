# Policy enrolment (D-33, D-40): what the enrolment operator's token may do, used only by deploy/openbao/enrol.mjs after it has counted two
# registered passwordless keys in Keycloak. It creates a person's two Transit keys (non-exportable; key moves need key-move.hcl and two
# approvers) and the person's entity and jwt alias. Nothing under kv/: an operator never reads a person's secrets.

# Create and read the person's keys; no delete, no export, no config change.
path "transit/keys/person-*" {
  capabilities = ["create", "read", "update"]
}
path "transit/keys/kek-*" {
  capabilities = ["create", "read", "update"]
}

# The person's entity and its alias on the jwt mount (enrolment, and re-binding at administrator-attested re-enrolment).
path "identity/entity" {
  capabilities = ["create", "update"]
}
path "identity/entity/name/*" {
  capabilities = ["create", "read", "update"]
}
path "identity/entity/id/*" {
  capabilities = ["read", "update"]
}
path "identity/entity-alias" {
  capabilities = ["create", "update"]
}
path "identity/entity-alias/id/*" {
  capabilities = ["read", "update"]
}
path "identity/lookup/entity" {
  capabilities = ["update"]
}
path "sys/auth" {
  capabilities = ["read"]
}
