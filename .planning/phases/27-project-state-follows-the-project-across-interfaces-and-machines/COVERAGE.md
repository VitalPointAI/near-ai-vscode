# API Coverage: project state sync and the online home (Phase 27)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
>
> The first version of this file said the phase used no external API. Plan 27-17 (D-14, SYNC-09)
> added the GitHub REST API, VS Code's built-in GitHub sign-in and the gh CLI, so the matrix now
> lists every external surface the phase reaches.

| capability | decision | reason |
|---|---|---|
| Project git remote via system git (near-ai/state branch only) | INTEGRATE | |
| GitHub REST API: create a repository for the signed-in user (POST /user/repos) | INTEGRATE | |
| GitHub REST API: read a repository and the signed-in login (resume and checks) | INTEGRATE | |
| GitHub REST API: set the default branch (PATCH /repos/{owner}/{repo}) | INTEGRATE | |
| VS Code GitHub authentication provider (getSession github, repo scope) | INTEGRATE | |
| gh CLI fallback (gh auth token, gh repo create) | INTEGRATE | |
| Push of the person's own code branch after the secret check | INTEGRATE | |
| NEAR AI Cloud API | OPT-OUT | Unchanged by this phase; its key is only carried as sealed data |
| GitLab and self-hosted git host APIs | OPT-OUT | Deferred by D-09 and D-14 to the later private-remote setting |
| GitHub repository deletion and other settings changes | OPT-OUT | Never done by the extension; only the default branch moves, away from near-ai/state, after the person's code push |
| Third-party sync or storage services | OPT-OUT | Not used: the bundle travels only through the project's own git remote |
