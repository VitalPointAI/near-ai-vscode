## What and why

<!-- What does this change do, and why is it needed? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran and what they showed. Add screenshots for UI changes. -->

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:e2e` (if the change touches activation, the sidebar, commands or webviews)
- [ ] `npm run verify:release` (if the change touches packaging, `.vscodeignore`, media or vendored code)

## Security and privacy

- [ ] No secrets, keys, tokens or private data in the code, tests, logs or this description
- [ ] Does not change where data goes, what the agent may do without asking, or how keys are stored; **or** SECURITY.md is updated to match
- [ ] No new runtime dependency (`npm ls --omit=dev --all` is still empty); new dev dependencies are pinned

## Docs

- [ ] User-visible change: CHANGELOG entry in plain language (or noted for the next release PR)
- [ ] README updated if features, settings, commands or troubleshooting changed
- [ ] Not user-visible: no docs needed

## Rollback

<!-- How to undo this if it causes trouble: usually "revert the squash commit"
     (gh pr revert <number>). Note anything that a revert does not undo, such as
     data written in a new format, settings migrations or published releases. -->
