# mend: 100/100 Practice Score, Complete Unified/SEARCH-REPLACE/V4A/JSON 3-Tier Matcher

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/akbar99-make/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/akbar99-make/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. Agent harnesses apply
edits that models write, and models write them in four formats: a unified
diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. `mend` reads all four to one
written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122)
— "Build mend, one patch tool for every AI edit format".

## Results

| Check group | Practice score |
| --- | --- |
| unified (30 checks) | 30/30 |
| search_replace (20 checks) | 20/20 |
| v4a (20 checks) | 20/20 |
| json (15 checks) | 15/15 |
| cli (15 checks) | 15/15 |
| **Total (100 checks)** | **100/100 — practice score 1000** |

- **Deterministic:** the same check gives the same exit code, stdout and
  files every run (two full practice runs: identical results).
- **Runtime:** ~0.20 s per check (100 checks in ~20 s, mostly Node startup).
- **Extra validation:** 20 hand-built checks for sentences of SPEC.md the
  public practice set does not show (hunk drift, pure renames, `\ No
  newline` on both sides, tier-2 re-indentation, SEARCH/REPLACE path
  reuse, V4A anchor + end-of-file, multiple failures, change-and-change-back)
  — 20/20 passed.
- **Limits:** Node 22 standard library only; `main.ts` is 34,060 bytes
  (987 lines); the whole source is ~41 KB, far under the 1 MiB per file
  and 4 MiB total caps.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- `PATCH` is the patch file, relative to the working directory. When it is
  absent or is `-`, the patch is read from standard input.
- Options and `PATCH` may come in any order. `--` ends the options.

### Exit codes and output

- Exit 2, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.
- Exit 1, nothing written: one `error: <code> <path>` line per failed
  edit, in the patch's order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`.
- Exit 0: one line per changed path in byte order (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), then `ok: <n> files` (or `ok: 1 file`).

### The four formats

- **Unified diffs** — sections from `diff --git` or bare `---`/`+++`
  pairs; creations, deletions and renames; hunks matched at the nearest
  occurrence to their (possibly wrong) line number, with drift carried
  across hunks; `\ No newline at end of file` honoured.
- **SEARCH/REPLACE** — blocks with a path line (fences skipped, path
  reused from the previous block when absent); old lines must occur
  exactly once at their tier, or the block fails `ambiguous`.
- **V4A** — `*** Add File`, `*** Delete File`, `*** Update File` with
  optional `*** Move to:`; chunks anchored by `@@` lines and moved along
  by a cursor; `*** End of File` anchors a chunk to the file's end.
- **JSON** — one array of edit objects, or JSON Lines; `create`,
  `str_replace` (exact, overlapping occurrences counted) and `insert`,
  with CRLF files read and written back as CRLF.

### Matching (three tiers)

Old lines are found at the first tier where they occur at least once:
tier 0 — every line equal; tier 1 — trailing spaces and tabs ignored;
tier 2 — leading and trailing spaces and tabs ignored, with new lines
re-indented to the file's indent. `--strict` tries tier 0 only.
Context lines are always written as the file's own matched lines.

### Atomicity

Edits apply in the patch's order to the tree as earlier edits left it.
A failed edit changes nothing and the edits after it still run, so every
failure is reported. When any edit failed, no file is written.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's runner, kept as it is; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT.

## Validating

Copy the kit's `starter/check.ts` beside `main.ts` and `runner.ts`, then:

```
node check.ts <path to the kit>/program/generator/practice.json
```

Expected: `100 of 100 passed` — practice score `1000`.
