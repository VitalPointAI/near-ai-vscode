#!/bin/bash
# Keycloak's Postgres (D-18): TLS only, SCRAM only, from the cluster only.
#   On an empty data folder: initdb with SCRAM authentication, then the keycloak role and database, passwords read from the mounted Secret.
#   On every start: ssl = on with the certificate and key from the mounted Secret sterling-postgres-tls, TLS 1.2 at least, and a pg_hba.conf
#   whose only network lines are hostssl with scram-sha-256 from the cluster ranges, so a connection without TLS is refused.
# Settings (environment): PGDATA; POSTGRES_TLS_DIR (tls.crt, tls.key, ca.crt; default /etc/postgres-tls); POSTGRES_SECRETS_DIR
# (superuser-password, keycloak-password; default /etc/postgres-secrets); POSTGRES_ALLOW_CIDRS (comma-separated CIDRs, required).
set -euo pipefail

: "${PGDATA:?sterling-postgres: PGDATA is not set}"
TLS_DIR=${POSTGRES_TLS_DIR:-/etc/postgres-tls}
SECRETS_DIR=${POSTGRES_SECRETS_DIR:-/etc/postgres-secrets}
: "${POSTGRES_ALLOW_CIDRS:?sterling-postgres: POSTGRES_ALLOW_CIDRS is not set}"
for file in "$TLS_DIR/tls.crt" "$TLS_DIR/tls.key" "$TLS_DIR/ca.crt" "$SECRETS_DIR/superuser-password" "$SECRETS_DIR/keycloak-password"; do
  [ -s "$file" ] || { echo "sterling-postgres: $file is missing or empty; refusing to start" >&2; exit 1; }
done

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "sterling-postgres: initialising a new data folder" >&2
  initdb -D "$PGDATA" -U postgres --auth=scram-sha-256 --pwfile="$SECRETS_DIR/superuser-password" --encoding=UTF8 --locale=C >/dev/null
  pg_ctl -D "$PGDATA" -o "-c listen_addresses='' -c unix_socket_directories=/tmp" -w -s start
  PGPASSWORD=$(cat "$SECRETS_DIR/superuser-password") psql -h /tmp -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -v password="$(cat "$SECRETS_DIR/keycloak-password")" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'password';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
  pg_ctl -D "$PGDATA" -w -s stop
fi

# The server key must be owned by the server user and private; the Secret's files are not, so they are copied in.
install -m 0600 "$TLS_DIR/tls.key" "$PGDATA/server.key"
install -m 0644 "$TLS_DIR/tls.crt" "$PGDATA/server.crt"
install -m 0644 "$TLS_DIR/ca.crt" "$PGDATA/root.crt"

cat > "$PGDATA/sterling.conf" <<'CONF'
listen_addresses = '*'
unix_socket_directories = '/run/postgresql'
password_encryption = scram-sha-256
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_ca_file = 'root.crt'
ssl_min_protocol_version = 'TLSv1.2'
log_connections = on
log_disconnections = on
log_destination = 'stderr'
logging_collector = off
CONF
grep -qx "include_if_exists = 'sterling.conf'" "$PGDATA/postgresql.conf" || echo "include_if_exists = 'sterling.conf'" >> "$PGDATA/postgresql.conf"

{
  echo "# Written by sterling-postgres at every start: TLS with SCRAM from the cluster only; no plain host lines."
  echo "local all all scram-sha-256"
  IFS=',' read -ra CIDRS <<< "$POSTGRES_ALLOW_CIDRS"
  for cidr in "${CIDRS[@]}"; do
    if [ -n "$cidr" ]; then echo "hostssl all all $cidr scram-sha-256"; fi
  done
} > "$PGDATA/pg_hba.conf"

exec postgres -D "$PGDATA"
