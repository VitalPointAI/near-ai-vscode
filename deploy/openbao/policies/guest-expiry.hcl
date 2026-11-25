# Policy guest-expiry (D-62, D-63, 47-19): what the automatic end of guest accounts may do, through the jwt role guest-expiry, which admits only
# tokens Keycloak issued to the client sterling-guest-expiry (47-20's CronJob). It reads guest entities and disables them, and nothing else:
# allowed_parameters admits the field disabled with the value true only (the JSON boolean; OpenBao 2.7.3 refuses the string "true"), so it
# can never enable an entity or set its policies, metadata or name, and the path never reaches a staff entity (keycloak-<id>).
# OpenBao counts a write to a name that does not exist as an update, so this token could create an empty, disabled entity named guest-<x>
# with no alias, metadata or policy: it grants nothing, guests.mjs reads before it writes, and deploy/openbao/enrol.mjs refuses such an entity.
# An early end files one revocation request in the site's revocation inbox (71 D-22), create only: it can never read, change or delete one;
# capabilities-self tells a request that exists already (a second write is refused) from a token that may not file at all.

path "identity/entity/name/guest-*" {
  capabilities = ["read", "update"]
  allowed_parameters = {
    "disabled" = [true]
  }
}

path "kv/data/site/revocation-requests/guest-*" {
  capabilities = ["create"]
}

# The end record that starts the retention period after which a security officer removes the guest's secrets (D-84), create only.
path "kv/data/site/guest-ended/guest-*" {
  capabilities = ["create"]
}

path "sys/capabilities-self" {
  capabilities = ["update"]
}

# The job's own token.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
