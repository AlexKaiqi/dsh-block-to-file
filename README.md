# @deepseek-ai/dsh-block-to-file

Model-facing **block-to-file (b2f)** runtime pipeline plugin.

Fenced code blocks whose info string contains `file=` are committed through a
plugin-owned Git object store before any tool call of the same assistant message
executes. The workspace at `$DSH_B2F_ROOT` does **not** need a `.git` directory;
only the Git executable is required. The plugin is **not a tool**: it observes
`assistant/message`, validates every block, compares the target blobs with the
agent's snapshot, and publishes all files as one commit with `git update-ref`
CAS.

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

The bare object store lives at `<root>.b2f-git`. Git index construction and
workspace-projection temp files live in `<root>.b2f-tmp` (or `$DSH_B2F_TMP`).
Both locations are outside the workspace.

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

`root` must be an absolute workspace path, but it does not need to be a Git
worktree. On first use b2f snapshots the workspace into its private bare store
and creates `canonicalRef` from that baseline; after that the canonical ref is
the only publication source of truth. Existing or nested Git worktrees contribute
their tracked files without exposing their `.git` object stores. Unrelated
concurrent b2f commits are retained when a candidate is rebuilt on the latest
canonical head.

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

Mount the plugin in the Host composition, where its `b2f` service can be shared
by every Agent session:

```yaml
- id: block-to-file
  name: '@deepseek-ai/dsh-block-to-file'
  config:
    root: $WS
```

Do not mount this service provider as a loose row in an Agent preset. A preset
that owns b2f must isolate the `b2f` service and place every consumer in that
same isolate realm.

b2f replaces the model-facing `str_replace_editor` write path. Remove or
disable the official editor in YOUR composition (preset / overlay) — this
package intentionally does not patch or remove any official plugin.

For generic per-agent checkouts or sandboxes, install a path-aware root
resolver at activation time and retain its Fiber-scoped disposer. Return
`undefined` for paths the resolver does not own so older registrations or the
default Session workspace can handle them:

```ts
const dispose = ctx.b2f.registerRootResolver(
  (agent, session, paths) => paths?.every(isCheckoutPath)
    ? {
        root: checkoutRootFor(agent, session),
        scope: 'checkout',
        authorization: 'mounted-workspace',
      }
    : undefined,
)
ctx.effect(() => dispose)
```

A consumer that owns an external canonical store may also register an async
publisher. Same-message tools await the newest publisher that claims the
transaction; a rejection becomes `publication-failed` and blocks those tools.
A successful receipt is rendered separately from the local workspace commit:

```ts
const disposePublisher = ctx.b2f.registerPublisher(async request => {
  if (request.scope !== 'checkout') return undefined
  const result = await publishCanonical(request)
  return { scope: 'example', revision: result.revision, noOp: result.noOp }
})
ctx.effect(() => disposePublisher)
```

Every path is resolved independently. If one message spans more than one root
or named scope, the whole transaction fails with `MIXED_ROOT_SCOPE`. Resolvers
may prepare a scope asynchronously. The newest resolver returning a claim wins.
When `ctx.sandboxPolicy` is mounted, b2f consumes that same per-Session policy:
`read-only` rejects every mutation, `workspace-write` accepts the Session root
and trusted `mounted-workspace` claims, and `danger-full-access` retains the
configured b2f boundary. The default resolver uses
`session.header.cwd`, falling back to the static `config.root` / `$WS` /
`$DSH_B2F_ROOT` value. b2f pins an agent's canonical snapshot when its
repository view is first prepared and advances it only after commit or stale
feedback. When `ctx.fs` is mounted, a successful b2f settlement resolves and
stats each result through that provider and emits `fs/observed` before
same-message tools run. Provider-native `FsVersion` values are deliberately not
reused as Git blob observations; a read-capable plugin with exact b2f version
information may instead call `ctx.b2f.recordObservation(agentId, {...})`.

```yaml
# in your preset or overlay cordis.yml
- id: str-replace-editor
  disabled: true
```

`tool-bash` remains the single model-facing tool for operating on files.
