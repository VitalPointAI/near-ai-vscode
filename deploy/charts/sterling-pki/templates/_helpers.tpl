{{- /* The PEM bundle every site TLS check trusts: the site CA chain, plus the bootstrap CA certificate while it is still in use. */ -}}
{{- define "sterling-pki.trustBundle" -}}
{{- $parts := list -}}
{{- with .Values.siteCaChain | trim }}{{ $parts = append $parts . }}{{ end -}}
{{- with .Values.bootstrapCaCertificate | trim }}{{ $parts = append $parts . }}{{ end -}}
{{- if $parts }}{{ join "\n" $parts }}{{ printf "\n" }}{{ end -}}
{{- end -}}
