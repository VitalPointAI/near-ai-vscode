# TDX test fixtures

- `intel-sample-quote.bin`: a real Intel TDX quote (v4) from Phala Network's
  [dcap-qvl](https://github.com/Phala-Network/dcap-qvl) (`sample/tdx_quote`, MIT
  License, Copyright (c) 2026 Phala Network). Its certificate chain ends at Intel's
  SGX Root CA.
- `test-chain.pem` and `test-pck-key.pem`: a throwaway P-256 CA chain made with
  openssl for these tests only. The tests sign synthetic quotes with it and trust
  its root explicitly. It is never trusted by the extension.
