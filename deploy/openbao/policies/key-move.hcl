# Policy key-move (D-40, DESIGN section 5): the Transit paths used to move a person's keys from one site to another. Each needs two approvals
# from the identity group key-custodians (Control Groups). Attached only to the
# operators who run a move; key-custodians' members are added at the key ceremony (deploy/runbooks, 47-17). OpenBao does not notify
# approvers: the runbook does.

# Allow a key to be exported (a key configuration change).
path "transit/keys/+/config" {
  capabilities = ["update"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}

# Export and back up a key.
path "transit/export/*" {
  capabilities = ["read"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}
path "transit/backup/*" {
  capabilities = ["read"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}

# Restore and import a key at the receiving site.
path "transit/restore/*" {
  capabilities = ["update"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}
path "transit/keys/+/import" {
  capabilities = ["update"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}
path "transit/keys/+/import_version" {
  capabilities = ["update"]
  control_group = {
    factor "key-custodians" {
      identity {
        group_names = ["key-custodians"]
        approvals = 2
      }
    }
  }
}
