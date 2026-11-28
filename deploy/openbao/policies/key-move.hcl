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

# Phase 45.1 (D-03, D-07): the site's exchange keys never move, never become exportable and are never replaced, whatever two custodians approve.
# A deny on the exact path wins over the paths above. apply.mjs writes the site name in place of @SITE@.
path "transit/keys/exchange-receive-@SITE@/config" {
  capabilities = ["deny"]
}
path "transit/keys/exchange-receive-@SITE@/import" {
  capabilities = ["deny"]
}
path "transit/keys/exchange-receive-@SITE@/import_version" {
  capabilities = ["deny"]
}
path "transit/export/+/exchange-receive-@SITE@" {
  capabilities = ["deny"]
}
path "transit/export/+/exchange-receive-@SITE@/*" {
  capabilities = ["deny"]
}
path "transit/backup/exchange-receive-@SITE@" {
  capabilities = ["deny"]
}
path "transit/restore/exchange-receive-@SITE@" {
  capabilities = ["deny"]
}
path "transit/keys/release-@SITE@/config" {
  capabilities = ["deny"]
}
path "transit/keys/release-@SITE@/import" {
  capabilities = ["deny"]
}
path "transit/keys/release-@SITE@/import_version" {
  capabilities = ["deny"]
}
path "transit/export/+/release-@SITE@" {
  capabilities = ["deny"]
}
path "transit/export/+/release-@SITE@/*" {
  capabilities = ["deny"]
}
path "transit/backup/release-@SITE@" {
  capabilities = ["deny"]
}
path "transit/restore/release-@SITE@" {
  capabilities = ["deny"]
}
