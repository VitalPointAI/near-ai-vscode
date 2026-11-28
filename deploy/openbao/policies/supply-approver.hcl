# Policy supply-approver (D-18; 48.3-05): the token an approver of your organization's software registry gets from the jwt role
# supply-approver (the site file's supply.approvers, passkey step-up, client sterling-supply-review, 5 minutes). It can only look itself up,
# which is how the review command learns who signed in (subject, entity, sign-in time); the approval is signed elsewhere, with the site key.
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
