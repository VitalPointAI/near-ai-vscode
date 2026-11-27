# Exclude local scratch from the VSIX

Base `49b305a57`. A local branding package listed 95 files from the root `.scratch` directory and passed the release content verifier. Use the lock-matched VSIX packager and a harmless nested `.scratch` sentinel to show the current package lists it. Keep `media/policy/policy.css` in the package. Add the root `.scratch` rule to `.vscodeignore` and compare the new file list with the original list after removing scratch entries. Report the exact local branch and gate classification.
