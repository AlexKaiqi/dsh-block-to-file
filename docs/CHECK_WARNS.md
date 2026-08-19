# Plugin check warns

`plugin check --root .` reports zero errors. The single remaining warn is
accepted, with a reason. Per the workbench's D-004, a heuristic warn needs review
and an explanation — not a code change that games the scan.

Re-audit this file whenever the rule set version changes.

## CAND-001 — 未声明可脚本化 CLI 入口

**Accepted, does not apply.** This is a candidate rule, `warn` by design and
statistical while it is being evaluated.

b2f is not an operational tool and registers none: it observes
`assistant/message` and publishes the file blocks found there before any tool
call in that message runs. Its model-facing surface is the block protocol
(`spec/block-protocol.json`), not a command line, and there is no host-local
workflow for a script to drive — the repository operations it performs are
already reachable through `git` itself.

A CLI would additionally have to reproduce the observation model that makes b2f
correct (a proposal is resolved against the *observed blob*, not the worktree; see
`src/model/README.md` and the `spec/block-protocol.json` `resolution` section).
A second entry point into that logic is a liability, not a feature.

## Notes on rules that now pass for the right reason

- **SEC-001** previously matched only because `refs/heads/agent-canonical` and
  `resolveCanonicalRevision` contain the substring `canonical`. It now passes on
  real assertions: `tests/validator.spec.ts` asserts `PATH_ABSOLUTE` and
  `PATH_ESCAPE` rejections, and `tests/transaction.spec.ts` asserts a symlinked
  ancestor cannot be written through.
- **REL-001** had no genuine coverage at all. `tests/durability.spec.ts` now
  asserts idempotent replay, that a crash between `update-ref` and projection
  self-heals, that one unpublishable block withholds the whole message, and that
  temp residue stays bounded and outside the worktree.
