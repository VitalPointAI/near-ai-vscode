# Policy cert-manager (D-16, D-40, 47-13): what the ClusterIssuers site-pki and site-pki-hub may do through the auth/kubernetes role
# cert-manager. They post certificate signing requests to the site intermediate's two roles and nothing else: the intermediate's private key
# stays in OpenBao, and the roles limit the names (ingress: the site domain and the listed cluster service domains; hub: the hubs' names).
path "pki_int/sign/ingress" {
  capabilities = ["update"]
}

path "pki_int/sign/hub" {
  capabilities = ["update"]
}
