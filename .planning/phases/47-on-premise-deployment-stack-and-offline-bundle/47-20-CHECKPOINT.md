# 47-20 checkpoint: keycloak-config-cli 6.5.1 refuses the guests-only admin permission

**Type:** checkpoint:decision (blocking), Task 1 of 3. Reached 2026-11-25 on `feat/phase-47-20-21`. Nothing of 47-20 is committed: no runner, no image, no realm change. The plan says to stop here and leave the fallback to the coordinator.

## What was run

Under the heavy lock and the memory cap: Keycloak `quay.io/keycloak/keycloak@sha256:75b5c435...` (26.8.2, `start-dev`, https with a throwaway CA) and keycloak-config-cli `@sha256:303b5c80...` (6.5.1), with the realm `apply.mjs` prepares for the CI site plus the client `sterling-guest-expiry` (checkRealm problems 0). The permission was built through the admin REST API as the console does it, and exported. Guest A (`ada.observer`, end date passed), guest B (`bo.observer`) and staff S (`sam.staff`). The containers were removed afterwards.

## The client, as probed

The shape the plan names (confidential, service account on, standard, implicit and direct-grant flows off, secret `$(env:STERLING_GUEST_EXPIRY_CLIENT_SECRET)`, an audience mapper for `sterling-guest-expiry`) plus three settings Keycloak 26.8.2 needs:

- `defaultClientScopes: ["basic", "kc-admin-api"]`, `optionalClientScopes: []`. Keycloak 26.8 accepts an admin API call only from a token whose audience holds the realm's admin API address; the built-in client scope `kc-admin-api` (mapper `oidc-admin-api-audience-mapper`) adds it. Without it every call answers 401 ("Expected audience not available in the token"), even with a realm-management role. `basic` keeps `sub` in the token for OpenBao's `user_claim`.
- `fullScopeAllowed: false`: the token carries no realm role.

Token: `aud ["https://<host>/admin/realms/sterling", "sterling-guest-expiry"]`, `azp sterling-guest-expiry`, no `realm_access`, no `resource_access`.

## The permission, as probed

Realm switch `adminPermissionsEnabled: true` (fine-grained admin permissions v2). In the `admin-permissions` client: a client policy naming `sterling-guest-expiry`, and a scope permission on resource type `Groups`, the one resource the group `guests` (by its id), scopes `view`, `view-members`, `manage-members`, decision UNANIMOUS. The service account holds no realm-management role (only `default-roles-sterling`).

## The probe table (the job's own client-credentials token)

| # | Operation | Guest A | Staff S |
|---|---|---|---|
| 1 | `GET group-by-path/guests`, then `GET groups/{id}/members?briefRepresentation=false` | 200, 200; A listed with attributes (`GET groups?search=guests&exact=true` answers 403; the job does not use it) | S not listed |
| 2 | `GET users/{id}` | 200 | 403 |
| 3 | `GET users/{id}/role-mappings` | 200 | 403 |
| 4 | `GET users/{id}/groups` | 200 | 403 |
| 5 | `PUT users/{id}` with `enabled: false` | 204 | 403 |
| 6 | `PUT users/{id}` with `guestEndedAt` and `guestEndedReason` added | 204; the other guest attributes unchanged | 403 |
| 7 | `POST users/{id}/logout` | 204 | 403 |

Every row passed with no realm-management role; no alternative was needed. Also refused with the job's token: `GET users?username=...` 403, `GET users/{S}/credentials` 403, `GET clients` 403, `GET groups` 403. S stayed enabled with no attributes. The same table held for guest B after the permission was re-created and the realm applied again. 47-31 relies on rows 1 and 7 of this table.

## What refused

The realm with the `admin-permissions` client and its authorization settings, applied by keycloak-config-cli 6.5.1 (exit 1):

```
INFO  ClientImportService : Skipping 'admin-permissions' client in realm 'sterling' - FGAP V2 is active and this client is system-managed by Keycloak.
      Remove it from your import configuration and use 'adminPermissionsEnabled: true' at realm level instead.
ERROR KeycloakConfigRunner : Error during Keycloak import: Cannot update client 'admin-permissions' in realm 'sterling': HTTP 403 Forbidden{"error":"HTTP 403 Forbidden"}
```

Its code says why: it skips authorization settings for `admin-permissions` under v2 because "FGAP V2 manages this client internally and blocks API access (see keycloak/keycloak#43977)".

What does work with keycloak-config-cli 6.5.1:
- the realm switch alone (`adminPermissionsEnabled: true`, without the `admin-permissions` client): exit 0, the switch is on;
- a permission made through the admin REST API survives a later keycloak-config-cli run of the realm (checked: both policies still there, the probe table unchanged).

## Options for the decision

1. **An admin REST step after keycloak-config-cli (the plan's named fallback).** The realm applier Job gets a second, idempotent step that reads the group `guests` and the client, and writes the client policy and the scope permission if they differ, with the applier's own master-realm credentials. checkRealm cannot see the permission (it is not in realm.json), so the step itself carries the rule "only `guests`, only these three scopes", and a test pins its request bodies. Changes how the realm is applied.
2. **Owner item 17's alternative.** No in-cluster job: the operator runs `guests.mjs expire` from the admin host with an administrator token, on a schedule the runbook sets. No Keycloak permission, image or CronJob. An overdue guest stays enabled until the operator runs it; `guests.mjs list` shows them.
3. **Fine-grained admin permissions v1** with keycloak-config-cli's placeholders. Needs the deprecated v1 feature switched on in Keycloak and the realm-management client's permissions; v1 and v2 cannot both run. Not recommended.

The probe answered every row with the guests-only permission, so option 1 keeps the design the plan wants (D-63, owner item 17); it is the coordinator's call.
