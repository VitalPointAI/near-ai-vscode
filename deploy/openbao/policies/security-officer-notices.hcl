# Policy security-officer-notices (D-84; 47-34): the notice a security officer's workbench shows, through the jwt role
# security-officer-notices (the site file's securityOfficers, no step-up, a 60-second token). The notice holds a count and the time of the
# check, never who.
path "kv/data/site/notices/guest-secrets-removal" {
  capabilities = ["read"]
}
