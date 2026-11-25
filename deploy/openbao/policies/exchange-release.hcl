# Policy exchange-release (Phase 45.1, D-03): binding the label of an export to a partner with your organization's release key, the site's
# non-exportable ed25519 key release-<site> (apply.mjs writes the site name in place of @SITE@). Sign only. Attached only to role
# sterling-exchange-release-stepup, whose login needs the step-up acr and the subject of a release authority the site file's releaseAuthorities names.
# It cannot open, export, back up or change the key.
path "transit/sign/release-@SITE@" {
  capabilities = ["update"]
}
