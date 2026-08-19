# @deepseek-ai/dsh-block-to-file

Model-facing **block-to-file (b2f)** runtime pipeline plugin.

Fenced code blocks whose info string contains `file=` are committed into the
Git repository at `$DSH_B2F_ROOT` before any tool call of the same assistant
message executes. The plugin is **not a tool**: it observes `assistant/message`,
validates every block, compares the target blobs with the agent's repository
snapshot, and publishes all files as one commit with `git update-ref` CAS.

## Protocol

````markdown
```python file=src/app.py
def main():
    print("hello")
```
````

Attributes: `file` (required), `mode=write|create|update|append|delete` (default
`write`), plus one edit mode (below); `diff=full|limited|stats|none` (default
`limited`), `encoding=utf-8`, `newline=preserve|lf|crlf`.

`append` is computed from the observed blob and is idempotent: when that blob
already ends with the block content, b2f reports `[b2f] append skipped`.

All blocks in one assistant message are one transaction. If any target blob is
stale, nothing commits and feedback includes each stale file's latest complete
content, blob OID, repository revision, and intervening b2f commits. A stale
response becomes the agent's new observation for an immediate retry.

Git index construction and workspace-projection temp files live in
`<root>.b2f-tmp` (or `$DSH_B2F_TMP`), outside the worktree.

## Partial edits

A partial edit is a front-end only: b2f resolves `(observed blob, patch) → full
content` and the result travels the same path as any full-content proposal
(stale comparison, precondition checks, ref CAS, projection, diff feedback).
Resolution is pure and runs against the exact bytes of the blob the model
observed — never the worktree and never through `git apply`, so no clean/smudge
filter, `core.autocrlf`, or `apply.whitespace` setting can alter content on the
way in.

`editFormat` selects **one** dialect. Only that dialect is described in the
system prompt and only its mode is accepted, so the model never has to choose
between patch formats; the other is rejected with `EDIT_MODE_DISABLED`.

`editFormat: replace` — anchors are content:

````markdown
```python file=src/client.py mode=edit
<<<<<<< SEARCH
    timeout = 1
=======
    timeout = 3
    retries = 5
>>>>>>> REPLACE
```
````

Each SEARCH is matched against the observed content and must match **exactly
once**; spans must not overlap. An empty REPLACE deletes. Insert by keeping the
anchor lines in both sections. Matching is order-independent, so a failure is
always attributable to one edit.

`editFormat: git_diff` — anchors are line numbers plus context:

````markdown
```python file=src/client.py mode=diff
@@ -40,3 +40,4 @@
 def connect():
-    timeout = 1
+    timeout = 3
+    retries = 5
     return client
```
````

Emit hunks only — no `diff --git`, `index`, `---`, or `+++` lines. Stated line
counts are ignored and recomputed from the body (as `git apply --recount` does),
and the `@@` start line is a **hint**: the hunk is located by searching outward
for its context, nearest match winning, up to `maxEditDrift` lines. This
tolerates the line drift that plain `git apply` cannot recover from.

Both dialects allow several edits per block and preserve the file's existing line
endings, so `newline=` is rejected on an edit block. When anchors do not resolve,
nothing commits and feedback returns the current content to re-anchor on.

Content echoed in `[b2f]` feedback is labelled `path=`, not `file=`, so a model
that copies an echo back verbatim writes nothing. Under `git_diff` those echoes
are line-numbered to match the `read` tool's format.

## Configuration

```yaml
b2f:
  root: "$WS"                # expands $WS / $DSH_B2F_ROOT; DSH_B2F_ROOT env wins
  editFormat: git_diff       # git_diff | replace | none
  maxEditDrift: 200          # lines a mode=diff hunk may drift from its @@ line
  maxFileSize: 1048576
  maxTotalSize: 2097152
  maxFilesPerMessage: 16
  diffLineLimit: 200
  canonicalRef: refs/heads/agent-canonical
  maxCasRetries: 8
  tempFileKeep: 16
```

Set `editFormat: none` to disable partial edits entirely.

Each settled transaction is emitted as `b2f/transaction` with the full report.
Per-block `editFormat`, `editsProposed`, `editsApplied`, and `fuzz` are carried
on every result, so first-apply success rate, retry counts, and drift tolerance
can be compared across dialects without this plugin aggregating anything.

`root` must be a Git worktree root with a valid `HEAD` commit. On first use b2f
creates `canonicalRef` from `HEAD`; after that the canonical ref is the only
publication source of truth. Unrelated concurrent commits are retained when b2f
rebuilds its candidate on the latest canonical head.

## Environment

| Variable | Purpose |
|---|---|
| `DSH_B2F_ROOT` | workspace root; `file=` paths are relative to it |
| `DSH_B2F_PLUGINS_DIR` | public plugin-artifact root (default `$DSH_B2F_ROOT/plugins`) |
| `DSH_B2F_PRIVATE_DIR` | private plugin state (default `$DSH_B2F_ROOT/.b2f/plugins`) |
| `DSH_B2F_TMP` | atomic-write temp dir (default `<root>.b2f-tmp`, outside the working tree) |

## Testing

```sh
pnpm install
pnpm check
```

## Usage

Until the package is published, build it from this checkout and add the local
directory to the DSH profile:

```sh
pnpm install
pnpm build
dsh plugin --profile web add "$PWD"
```

Mount the plugin beside your agent composition (for example in a preset or an
overlay `cordis.patch.yml`):

```yaml
- id: block-to-file
  name: '@deepseek-ai/dsh-block-to-file'
  config:
    root: $WS
```

b2f replaces the model-facing `str_replace_editor` write path. Remove or
disable the official editor in YOUR composition (preset / overlay) — this
package intentionally does not patch or remove any official plugin.

For generic per-agent checkouts or sandboxes, install a root resolver at
activation time:

```ts
ctx.b2f.setRootResolver((agent, session) => checkoutRootFor(agent, session))
```

The default resolver uses `session.header.cwd`, falling back to the static
`config.root` / `$WS` / `$DSH_B2F_ROOT` value. b2f pins an agent's canonical
snapshot when its
repository view is first prepared and advances it only after commit or stale
feedback. A read-capable plugin with exact path information may replace the
snapshot fallback with `ctx.b2f.recordObservation(agentId, {...})`;
b2f itself has no dependency on that plugin.

```yaml
# in your preset or overlay cordis.yml
- id: str-replace-editor
  disabled: true
```

`tool-bash` remains the single model-facing tool for operating on files.
