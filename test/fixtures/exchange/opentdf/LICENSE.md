# Licence of manifest.schema.json and examples.json

Both files are test data copied from the OpenTDF specification, https://github.com/opentdf/spec, at commit
`0a30366b18b58a314a570ea06c03e6c92c985ab5` (2026-07-22), whose `VERSION` file reads 4.3.0. They are read by tests only and never run.

- `manifest.schema.json` is `schema/OpenTDF/json-schema/schema.json`, copied unchanged.
- `examples.json` holds the JSON examples of `schema/OpenTDF/manifest.md`, `key_access_object.md`, `integrity_information.md` and `payload.md`,
  as values of one JSON object with field names of our own and a `source` field. The examples' `//` comments were removed so they parse as JSON.
  The full manifest example's `assertions` array was left out, because it holds an example NATO confidentiality label and no NATO label value is
  kept in this repository. Nothing else was changed.

The specification is licensed under BSD-3-Clause-Clear. Its licence text, from the repository's `LICENSE` file at that commit, follows.

---

The Clear BSD License

Copyright (c) 2017-2022 Virtru Corporation
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted (subject to the limitations in the disclaimer below)
provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of Virtru Corporation nor the names of its contributors may be used to endorse or promote products derived from this software without
  specific prior written permission.
NO EXPRESS OR IMPLIED LICENSES TO ANY PARTY'S PATENT RIGHTS ARE GRANTED BY THIS LICENSE. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
