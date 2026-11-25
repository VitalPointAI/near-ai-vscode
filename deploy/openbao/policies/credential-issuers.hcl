# Policy credential-issuers (Phase 71, 71-12; D-14, D-15, D-22): what an officer's backend may do in your organization's OpenBao when it issues,
# revokes or suspends a credential. Attached only to role sterling-issuer-stepup, whose login needs the step-up acr and the officer's own sub,
# named in the site file's credentialIssuers at the key ceremony; a session token and a person's own step-up token never hold it. Whether the
# officer holds a role that allows the credential is checked by their backend first (issuerAuthority); both must allow. deploy/openbao/apply.mjs
# fills in the site name. No path here reaches anyone's wallet, identity record or other secrets, administers a key, or deletes a record other
# than a resolved revocation request.

# Sign status lists with the site's status-list key (ed25519, non-exportable; apply.mjs creates it). Signing only: no key read or administration.
path "transit/sign/status-list-${site.siteName}" {
  capabilities = ["update"]
}

# Deliver a new credential to the person it is about: create only, so an officer never sees or changes what someone holds.
path "kv/data/users/+/credentials-inbox/*" {
  capabilities = ["create"]
}

# The site's people directory, kv/site/people/<entity> = { did }, each written by that person's own backend: find a person's DID.
path "kv/data/site/people/*" {
  capabilities = ["read"]
}
path "kv/metadata/site/people/*" {
  capabilities = ["list"]
}

# The revocation inbox (D-22), filed once by 47-20 (a guest ended early) and 47-31 (a person disabled or removed in sign-in). An officer
# reads the requests and, once every credential issued to that person is revoked or suspended, removes the request (all versions).
path "kv/data/site/revocation-requests/*" {
  capabilities = ["read"]
}
path "kv/metadata/site/revocation-requests/*" {
  capabilities = ["read", "list", "delete"]
}

# A request names the person's OpenBao entity by name; reading it gives the entity id the people directory is keyed by.
path "identity/entity/name/*" {
  capabilities = ["read"]
}

# The issued register, kv/site/issued/<entity>/<credential hash>: what was issued to whom, by whom, with which status entries; never a
# credential body. Written once at issuance and kept.
path "kv/data/site/issued/*" {
  capabilities = ["create", "read"]
}
path "kv/metadata/site/issued/*" {
  capabilities = ["list"]
}

# People's computer slots (D-25), kv/site/device-slots/<entity>/slot-<n>: read to revoke a computer a request names; a lost computer's slot
# is removed once its binding is revoked, which frees it for another computer.
path "kv/data/site/device-slots/*" {
  capabilities = ["read"]
}
path "kv/metadata/site/device-slots/*" {
  capabilities = ["list", "delete"]
}

# Status list indexes, claimed once each (check-and-set 0), so two officers never give the same index to two credentials.
path "kv/data/site/status-index/*" {
  capabilities = ["create"]
}
