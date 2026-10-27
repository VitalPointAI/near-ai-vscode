# Changelog

## 0.4.0

A native agent that runs on NEAR AI's private models, with no proprietary
runtime in between.

- **Agent in the sidebar.** It reads, searches, edits and runs commands in your
  project, with approval cards that show diffs and commands, per-run grants,
  and one-click **Revert**.
- **Open-GSD workflows on NEAR AI.** `/gsd-…` commands run on the native runner
  with sub-agents (including background ones you can pause or stop), questions,
  and context management. Open-GSD is installed per user and checked against
  each new release.
- **Agent teams.** Teams are Markdown files you edit, version, duplicate,
  archive and import. Run one with `/team:<name>`. **Set Up Project Team**
  drafts one from a few questions.
- **Attachments.** Images are read by a vision model and audio is transcribed
  with Whisper. Text files are included inline.
- **Image generation** with NEAR's image models, saved through checkpoints.
- **Project memory.** Remember and Recall, reviewed with **Manage Project
  Memory**.
- **Verify signature.** Checks NEAR's signature over the exact request and
  response, and that a genuine Intel TDX quote, fresh for this check, binds
  the signing key.
- **Local and hybrid runtimes.** Ollama, LM Studio, vLLM, or any
  OpenAI-compatible server, alone or alongside NEAR AI Cloud.
- **Resumable chats.** Conversation history is kept on this machine.
- **Security hardening.**
  - Commands run without approval only when written as plain words.
  - `.git/` and the extension's settings are protected from silent writes.
  - Credential files ask first, however their path is written.
  - Fetches are restricted to public https addresses.
  - Sub-agents never use a less private model than the one you picked.
  - Keys are bound to their endpoint.
- **Default model:** GLM 5.3, which runs in NEAR's TEE.

## 0.3.1

- Marketplace listing rewritten.

## 0.3.0

- Native VS Code chat styling and an `@nearAi` chat participant.
- The extension leaves projects it didn't set up untouched.
