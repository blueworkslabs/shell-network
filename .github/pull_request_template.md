## What and why

<!-- One or two sentences: the behaviour that changes and the reason. -->

## How it was checked

- [ ] `npm test` (or `sh scripts/test.sh`) passes: strict `tsc`, then all offline tests
- [ ] New behaviour has a test, and a negative control that fails without the change
- [ ] Crash/restart paths considered (buffer, outbox head, reconcile) where the change touches them

## Safety

- [ ] No secrets, tokens, ids, hostnames or local paths in code, tests, fixtures or this description
- [ ] Discord writes still go only through the bridge's outbox; the tool still holds no credential
- [ ] Trust model or known limits in SECURITY.md updated if this changes them
