# Policy raft-snapshot (D-73, CP-9; 47-24): what the scheduled Raft snapshot job (CronJob openbao-raft-snapshot in deploy/values/openbao.yaml)
# may do, through the auth/kubernetes role raft-snapshot bound to its own ServiceAccount. It reads a snapshot of the Raft store and nothing
# else: no secret, key, policy or configuration. A snapshot is sealed by OpenBao's barrier, so it is useless without the HSM or the unseal
# shares.
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
