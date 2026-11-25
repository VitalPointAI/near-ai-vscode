# Policy guest-removal (D-62, D-63, 47-19): the deletes that remove a guest's records in OpenBao after your organization's retention period
# (the removal step of deploy/runbooks/guest-accounts.md). Every delete waits for two approvals from the identity group key-custodians
# (Control Groups). Attached only to the operators who run removals. No script uses it: nothing deletes a guest's records automatically.
#
# Only the entity path is limited to guests by name (guest-*). The Transit keys are named by entity id, so OpenBao cannot limit them to
# guests: transit/keys/person-<entity id> and kek-<entity id> look the same for staff. The two key custodians approving each delete check,
# before they approve, that the entity id in the request's path belongs to an entity named guest-<id> (T-47-76). Deleting a Transit key also
# needs deletion_allowed set on it first, which is a key configuration change behind the existing key-move Control Group
# (transit/keys/+/config).
#
# The guest's KV data (kv/metadata/users/<entity id>/...) is not here: every policy that reaches a person's KV path must name it through the
# entity template (deploy/test/openbao.test.mjs), and a removal path names another person's entity. How that data is removed is an open
# decision (compliance/gaps.json G447).

path "identity/entity/name/guest-*" {
  capabilities = ["delete"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}

path "transit/keys/person-*" {
  capabilities = ["delete"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}

path "transit/keys/kek-*" {
  capabilities = ["delete"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}
