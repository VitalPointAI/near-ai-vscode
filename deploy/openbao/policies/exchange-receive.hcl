# Policy exchange-receive (Phase 45.1, D-07): opening an object a partner addressed to your organization. Decrypt only, with the site's non-exportable
# RSA-3072 key exchange-receive-<site> (apply.mjs writes the site name in place of @SITE@). Attached only to role sterling-exchange-receive-stepup,
# whose login needs the step-up acr and the subject of an exchange officer the site file's exchangeOfficers names. It cannot encrypt, export, back up
# or change the key.
path "transit/decrypt/exchange-receive-@SITE@" {
  capabilities = ["update"]
}
