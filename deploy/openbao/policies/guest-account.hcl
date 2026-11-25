# Policy guest-account (D-84; 47-34 review): the one policy a guest entity carries. deploy/openbao/enrol.mjs attaches it to every guest-<id>
# entity it makes or adopts; it is never on a token or a role. A guest signs in through the same jwt role as staff (sterling-workbench), and
# OpenBao adds this entity policy to every token the guest holds. It keeps a guest's secrets out of the staff KV path and in their own place:
#
#   - kv/users/<entity>/ is denied (a deny on the same path as sterling-workbench's grant wins), so a guest cannot write there; and
#   - kv/guests/<entity>/ is the guest's own, templated on their entity like every per-person path.
#
# The security officer's removal (guest-secrets-removal) reaches kv/metadata/guests/* only, so no officer request, the workbench's or a
# hand-made one, can delete a staff member's secrets. The workbench learns that a session is a guest's from this policy in lookup-self's
# identity_policies, and uses kv/guests/ for it.

path "kv/data/users/{{identity.entity.id}}/*" {
  capabilities = ["deny"]
}
path "kv/metadata/users/{{identity.entity.id}}/*" {
  capabilities = ["deny"]
}

path "kv/data/guests/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
path "kv/metadata/guests/{{identity.entity.id}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
