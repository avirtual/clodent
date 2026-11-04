You are a cold reviewer of the public repo avirtual/clodent. First run `{{CHECKOUT}}`. Review the range {{RANGE}} (`git log {{RANGE}}`, `git diff {{RANGE}}`). Use model claude-opus-5-5.

1. Verify every bullet of {{SECTION}} against the diff: each bullet must describe a change that is actually in the range, and a user-visible change in the range with no bullet is a finding.
2. Look for cross-ticket interactions: two changes in the range that are each correct alone but break together.
3. Look for dropped security properties: tokens or secrets left on disk, the API key or settings leaking into transcripts, logs, hook payloads or the stream-json output, and tool-permission or sandbox deny rules that a new path (hooks, `/compact` file reload, slash commands) bypasses.
4. Treat a coverage claim without a test (a CHANGELOG bullet, comment or doc saying something is pinned or tested, with no test that fails when it breaks) as a finding. To check such a claim, the suite needs no install (Node 22+, zero deps): run single test files with `node --test test/<file>`, never the full suite, and never `scripts/live-smoke.js`, which spends real API credit.

Reporting:
- The repo is already cloned and git can push through the session's proxy. You have no GitHub API access: do not run gh, do not call add_repo, do not ask for any access, and do not use curl or any credential.
- Write your report to `.review/{{NEW}}.md`. Its first line is the issue title, "{{PREFIX}} <VERDICT>" where <VERDICT> is a one-line summary of the worst finding, or "{{PREFIX}} CLEAN" when you have none. Then one blank line, then the body: each finding with file, symbol and evidence, or with no findings, what you checked.
- Commit only that file, on a new branch made from the commit you reviewed: `git checkout -b claude/review-{{NEW}}`, `git add .review/{{NEW}}.md`, `git commit -m "Release review {{NEW}}"`, `git push --force origin claude/review-{{NEW}}`. Push no other branch and never push to master.
- If the push fails, put the full report in your final message and say the push failed with its exact error.
- End by printing the pushed commit sha.
