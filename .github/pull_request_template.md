## What and why

<!-- One or two sentences: the behaviour that changes and the reason. -->

## How it was checked

- [ ] `npm run typecheck` and the touched tests pass locally; CI runs the full suite (`npm test`)
- [ ] A behaviour change has a behaviour test; superseded tests are deleted (CONTRIBUTING.md)

## Safety

- [ ] No secrets, tokens, ids, hostnames or local paths in code, tests, fixtures or this description
- [ ] Discord writes still go only through the bridge's outbox; the tool still holds no credential
- [ ] Trust model or known limits in SECURITY.md updated if this changes them
