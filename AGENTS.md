# Development workflow

- Before committing code changes, run both a Codex CLI review of the complete
  uncommitted patch and a separate Codex CLI audit covering correctness,
  regressions, security, performance, and test coverage.
- Address every valid finding, then repeat both passes until they report no
  findings. Do not commit or push while either pass has unresolved findings.
- Once review and verification are clean, commit the complete intended change
  and push the current branch.
- After the push succeeds, install the committed `HEAD` as the latest stable
  `cc` with `node scripts/install-channel.mjs stable --ref HEAD`, then verify
  that the active `cc` launcher resolves to that commit.
