# mend

![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rangerkit/mend/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rangerkit/mend/reward.svg)

mend is a small command-line tool that applies an edit written by an AI model to a tree of text files. Models write
edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON — and mend reads each format exactly as `SPEC.md` says, matching lines at three
tiers (exact, trailing-whitespace-insensitive, then indentation-insensitive) so drifted whitespace and indentation
do not defeat an otherwise good edit. Every edit in a patch is checked before anything is written: if any edit
fails, nothing is written at all and each failure is reported.

## Running it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree); omit it or pass `-` to read
  the patch from standard input.
- `--format=NAME` forces one format (`unified`, `search-replace`, `v4a` or `json`); the default, `auto`, detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one `A`/`D`/`M`/`R` line per changed path, sorted by path, then `ok: <n> files`, and exits 0.
When edits fail it prints one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and
exits 1. Usage, unreadable-patch, format and parse problems print a single `error:` line and exit 2.

Requires Node 22 or newer; it uses the standard library alone.

## Practice checks

The kit's public practice set (100 checks) can be run locally:

    node check.ts <path-to-practice.json>

It prints every check that does not match the reference behaviour, then the practice score. This implementation
passes all 100 practice checks.

## Files

- `main.ts` — the CLI itself.
- `runner.ts` — the kit's trial runner (kept as the kit has it); `main.ts` hands a trial over to it when
  `MAKEFUN_ENV_URL` is set.
- `check.ts` — the local practice-set runner.
- `SPEC.md` — the full specification mend implements.
- `LICENSE` — MIT.
