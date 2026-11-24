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
# The secret goes to Quarkus through its environment name, not a -D argument, so it is not visible in the process list.
export QUARKUS_OIDC_CREDENTIALS_SECRET="$SECRET"
unset KEYCLOAK_CLIENTSECRET

exec java -Dtheia.cloud.service.auth.token="${SERVICE_AUTH_TOKEN:-${APPID:-}}" \
  -Dquarkus.http.port="${SERVICE_PORT}" \
  -Dtheia.cloud.auth.admin.group="${KEYCLOAK_ADMIN_GROUP}" \
  -Dtheia.cloud.use.keycloak="${KEYCLOAK_ENABLE}" \
  -Dquarkus.oidc.auth-server-url="${KEYCLOAK_SERVERURL}" \
  -Dquarkus.oidc.client-id="${KEYCLOAK_CLIENTID}" \
  -jar /service/service-1.2.0-runner.jar "$@"
