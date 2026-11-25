# Policy sterling-workbench (D-40, Phase 46 interface items 5 to 7): what a signed-in person's session token may do, through role
# sterling-workbench on auth/jwt. Every per-person path is templated on the person's own OpenBao entity, so a token reaches only its owner's
# secrets and keys. Under transit/keys/ only one read of the person's own signing key, for its public key: the workbench never creates,
# rotates, configures, exports or deletes a key (only deploy/openbao/enrol.mjs creates them). Signing is not here: it is granted only by
# sterling-workbench-sign, through the step-up role.

# The person's own secrets, KV v2 at kv/: kv/users/<entity>/<service>/<account>. A guest's entity policy guest-account denies this path and
# gives kv/guests/<entity>/ instead (D-84).
path "kv/data/users/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "kv/metadata/users/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# The site's people directory (Phase 71, 71-10; D-15): the person's own entry, kv/site/people/<own entity> = { did }, created once by their own
# backend at first sign-in and read back. Exactly this path: no other person's entry, no list, no update and no delete, so nobody can claim
# another person's DID or move their own to someone else's. Officers read the directory through credential-issuers (71-12).
path "kv/data/site/people/{{identity.entity.id}}" {
  capabilities = ["create", "read"]
}

# The person's own computer slots (Phase 71, D-25, owner decision 2026-11-25): binding one of their own computers claims a status list place
# for it. Exactly five slots, each under the person's own entity, create and read only: nobody claims another person's slot, nobody changes or
# removes a claimed one (an officer frees a slot once that computer is revoked), and a sixth computer has no slot to take.
path "kv/data/site/device-slots/{{identity.entity.id}}/slot-1" {
  capabilities = ["create", "read"]
}
path "kv/data/site/device-slots/{{identity.entity.id}}/slot-2" {
  capabilities = ["create", "read"]
}
path "kv/data/site/device-slots/{{identity.entity.id}}/slot-3" {
  capabilities = ["create", "read"]
}
path "kv/data/site/device-slots/{{identity.entity.id}}/slot-4" {
  capabilities = ["create", "read"]
}
path "kv/data/site/device-slots/{{identity.entity.id}}/slot-5" {
  capabilities = ["create", "read"]
}

# The places of computers only, each claimed once so no two computers share a status bit: create only, in the device part of the index space,
# never the places officers give to credentials (kv/site/status-index/<purpose>-<list>/). A person never signs a status list.
path "kv/data/site/status-index/device-*" {
  capabilities = ["create"]
}

# Reporting one of the person's own computers lost: a revocation request under the person's own entity name only, created once, never read
# or changed. An officer revokes that computer.
path "kv/data/site/revocation-requests/{{identity.entity.name}}-computer-lost-*" {
  capabilities = ["create"]
}

# The person's key-encryption key: wrap a new data key, and unwrap one.
path "transit/datakey/wrapped/kek-{{identity.entity.id}}" {
  capabilities = ["update"]
}
path "transit/decrypt/kek-{{identity.entity.id}}" {
  capabilities = ["update"]
}

# The person's own signing key, read only (Phase 33 D-61, owner decision 2026-11-24): the read answers the key's public keys, which the
# workbench checks every signature against and enters in a project's roster; a non-exportable key's private part is never in it. Exactly
# this name, as enrol.mjs creates it (person-<entity id>): no list, no other key, and no rotate, config, export, sign or delete, which are
# other paths or capabilities.
path "transit/keys/person-{{identity.entity.id}}" {
  capabilities = ["read"]
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
