# Contributing

This is a trial prototype. The process is kept small on purpose: a small fix should be live in under 30 minutes.

1. **One repository.** This public repository is the source, and staging installs from it.
2. **Per change:** the builder runs `npm run typecheck` and the tests the change touches. One reviewer reads the
   diff. CI runs the full suite (`npm test`) once on the pull request. Then merge, install, and send one real message
   through each bot.
3. **No extra gates.** No mutation campaigns, commit receipts, per-change live gates or bundles. Changes that touch
   tokens or grants get one security review on top.
4. **Scope line.** A rare duplicate message is acceptable. A finding beyond what real use needs goes on the backlog
   (an issue), not into code.
5. **Tests check behaviour.** Test what the bridge does through its interfaces (t3, Discord, the buffer across a
   crash), not SQL details, log names or source order. A change that supersedes a test deletes it in the same commit.
