#!/bin/sh
# The Theia Cloud service's start (D-22, hardening 5). The upstream image bakes in the public sample client secret; ours has none and
# refuses to start without a real one, so a site can never run on a secret anyone can read. Then it runs the upstream command unchanged.
set -eu

SAMPLE=publicbutoauth2proxywantsasecret
SECRET=${KEYCLOAK_CLIENTSECRET:-}
if [ -z "$SECRET" ]; then
  echo "theia-cloud-service: KEYCLOAK_CLIENTSECRET is not set; refusing to start (the client secret comes from Secret oauth2-proxy-secrets)." >&2
  exit 1
fi
if [ "$SECRET" = "$SAMPLE" ]; then
  echo "theia-cloud-service: KEYCLOAK_CLIENTSECRET is the public sample value from the upstream image; refusing to start." >&2
  exit 1
fi
: "${KEYCLOAK_SERVERURL:?theia-cloud-service: KEYCLOAK_SERVERURL is not set}"
case "$KEYCLOAK_SERVERURL" in
  https://*) ;;
  *) echo "theia-cloud-service: KEYCLOAK_SERVERURL must be an https:// address; refusing to start." >&2; exit 1 ;;
esac
# The site CA (ConfigMap sterling-site-ca, key ca.crt, 47-13) is the only trust for the OIDC calls to Keycloak. The upstream
# application.properties sets quarkus.oidc.tls.verification=none; here the OIDC client uses the TLS registry configuration sterling-site
# instead (certificate and host name checked against the site chain; Quarkus refuses to start if that configuration is missing), and the
# deprecated setting is also turned back to required. No file, or one without a certificate, refuses the start: never an unverified call.
SITE_CA=${STERLING_SITE_CA_FILE:-/etc/ssl/site-ca/ca.crt}
if [ ! -s "$SITE_CA" ] || ! grep -q -- '-----BEGIN CERTIFICATE-----' "$SITE_CA"; then
  echo "theia-cloud-service: the site CA $SITE_CA is missing or holds no certificate; refusing to start (ConfigMap sterling-site-ca)." >&2
  exit 1
fi
# The secret goes to Quarkus through its environment name, not a -D argument, so it is not visible in the process list.
export QUARKUS_OIDC_CREDENTIALS_SECRET="$SECRET"
unset KEYCLOAK_CLIENTSECRET
# Upstream's ApplicationLifecycleListener logs every configuration source at INFO when the service starts, the environment (this client
# secret) and the system properties (the service auth token) included, so both would reach the site log store. It logs only at INFO, so its
# category is set to WARN; nothing else in the service's logging changes.
QUIET_CONFIG_DUMP='-Dquarkus.log.category."org.eclipse.theia.cloud.service.ApplicationLifecycleListener".level=WARN'

exec java "$QUIET_CONFIG_DUMP" \
  -Dtheia.cloud.service.auth.token="${SERVICE_AUTH_TOKEN:-${APPID:-}}" \
  -Dquarkus.http.port="${SERVICE_PORT}" \
  -Dtheia.cloud.auth.admin.group="${KEYCLOAK_ADMIN_GROUP}" \
  -Dtheia.cloud.use.keycloak="${KEYCLOAK_ENABLE}" \
  -Dquarkus.oidc.auth-server-url="${KEYCLOAK_SERVERURL}" \
  -Dquarkus.oidc.client-id="${KEYCLOAK_CLIENTID}" \
  -Dquarkus.tls.sterling-site.trust-store.pem.certs="${SITE_CA}" \
  -Dquarkus.tls.sterling-site.trust-all=false \
  -Dquarkus.tls.sterling-site.hostname-verification-algorithm=HTTPS \
  -Dquarkus.oidc.tls.tls-configuration-name=sterling-site \
  -Dquarkus.oidc.tls.verification=required \
  -jar /service/service-1.2.0-runner.jar "$@"
