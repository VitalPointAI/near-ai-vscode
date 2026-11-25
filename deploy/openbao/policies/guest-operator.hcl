# Policy guest-operator (D-61 to D-63, 47-19): what the site operator's token may do through deploy/keycloak/guests.mjs. Attached only to the
# operators who create, extend and end guest accounts; enrolment itself stays with the enrolment policy (deploy/openbao/enrol.mjs).
#
# - Approving a guest: the approver's OpenBao entity (keycloak-<id>) is read for its id, and the site's people directory entry for that id
#   gives the approver's DID, whose SecurityContactCredential deploy/tools/credential-check.mjs then checks. Read only: a directory entry
#   holds a DID and nothing secret.
# - Ending and extending a guest: a guest's entity is read, then disabled (end) or enabled again (extend). allowed_parameters admits the
#   field disabled and nothing else, so this token cannot set policies, metadata or a name. OpenBao counts a write to a name that does not
#   exist as an update and creates the entity, so guests.mjs always reads the entity first and never writes one that is missing.
# - An early end files one revocation request in the site's revocation inbox (71 D-22), create only: it can never read, change or delete one.
#   capabilities-self tells a request that exists already (a second write is refused) from a token that may not file at all.

path "identity/entity/name/keycloak-*" {
  capabilities = ["read"]
}

path "kv/data/site/people/*" {
  capabilities = ["read"]
}

path "identity/entity/name/guest-*" {
  capabilities = ["read", "update"]
  allowed_parameters = {
    "disabled" = []
  }
}

path "kv/data/site/revocation-requests/guest-*" {
  capabilities = ["create"]
}

path "sys/capabilities-self" {
  capabilities = ["update"]
}
