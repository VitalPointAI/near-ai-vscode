# Policy sterling-workbench-sign (D-34, D-39, Phase 46 interface item 8): signing with the person's own key. Attached only to role
# sterling-workbench-stepup, whose login needs a token carrying the step-up acr and whose token is not renewable past the step-up window, so
# OpenBao itself refuses a signature without a fresh sign-in ceremony, whatever the workbench does.
path "transit/sign/person-{{identity.entity.id}}" {
  capabilities = ["update"]
}
