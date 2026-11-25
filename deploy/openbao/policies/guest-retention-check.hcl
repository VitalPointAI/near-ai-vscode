# Policy guest-retention-check (D-84; 47-34): the hourly CronJob guest-retention-check (deploy/values/openbao.yaml), through the kubernetes role
# guest-retention-check. It counts guests past their retention period whose secrets a security officer has not removed yet: it lists and
# reads the end records, lists the removal records, reads guest entities (to skip a guest who is enabled again), and writes the count to the
# officers' notice. It reads no person's secrets and deletes nothing.
path "kv/metadata/site/guest-ended/" {
  capabilities = ["list"]
}
path "kv/data/site/guest-ended/*" {
  capabilities = ["read"]
}
path "kv/metadata/site/guest-secrets-removed/" {
  capabilities = ["list"]
}
path "identity/entity/name/guest-*" {
  capabilities = ["read"]
}
path "kv/data/site/notices/guest-secrets-removal" {
  capabilities = ["create", "update"]
}
