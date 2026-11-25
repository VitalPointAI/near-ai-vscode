# Policy guest-secrets-removal (D-84, owner 2026-11-25; 47-34): what a security officer may do in the workbench's "Remove ended guests'
# secrets", and only in that officer's step-up token. It is held only by tokens of the jwt role guest-secrets-removal, which admits the
# subjects the site file names in securityOfficers after a passkey step-up, for the step-up window at most. There is no standing permission
# and no job holds it.
#
# The KV delete below is the one exception to the rule that every policy reaching a person's KV path names it through the entity template
# (deploy/test/openbao.test.mjs): a guest's secrets live under their entity id, which no template of the officer's own entity can name.
# OpenBao cannot limit the path to guests, so the workbench deletes only after checking that the entity is a disabled guest-<id> whose end
# record's removeAfter has passed and that has no removal record; OpenBao's audit device records every request with the officer's entity,
# and each removal writes a create-only removal record. Values are never read: list shows names, and delete removes every version.

# The end records (guests.mjs) and the removal records.
path "kv/metadata/site/guest-ended/" {
  capabilities = ["list"]
}
path "kv/data/site/guest-ended/*" {
  capabilities = ["read"]
}
path "kv/metadata/site/guest-secrets-removed/" {
  capabilities = ["list"]
}
path "kv/data/site/guest-secrets-removed/guest-*" {
  capabilities = ["create", "read"]
}

# A guest's entity, to check it is a disabled guest and find its id.
path "identity/entity/name/guest-*" {
  capabilities = ["read"]
}

# The guest's secrets: list their names and delete them (metadata delete removes every version).
path "kv/metadata/users/*" {
  capabilities = ["list", "delete"]
}

# The token's own: who the officer is (written into the removal record), and revoking it when done.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
