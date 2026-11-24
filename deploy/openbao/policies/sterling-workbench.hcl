# Policy sterling-workbench (D-40, Phase 46 interface items 5 to 7): what a signed-in person's session token may do, through role
# sterling-workbench on auth/jwt. Every per-person path is templated on the person's own OpenBao entity, so a token reaches only its owner's
# secrets and keys. Nothing under transit/keys/: the workbench never creates, rotates or deletes a key (only deploy/openbao/enrol.mjs does).
# Signing is not here: it is granted only by sterling-workbench-sign, through the step-up role.

# The person's own secrets, KV v2 at kv/: kv/users/<entity>/<service>/<account>.
path "kv/data/users/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "kv/metadata/users/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# The person's key-encryption key: wrap a new data key, and unwrap one.
path "transit/datakey/wrapped/kek-{{identity.entity.id}}" {
  capabilities = ["update"]
}
path "transit/decrypt/kek-{{identity.entity.id}}" {
  capabilities = ["update"]
}

# The session's own token.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
