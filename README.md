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

Attributes: `file` (required), `mode=write|create|append` (default `write`),
`diff=full|limited|stats|none` (default `limited`), `encoding=utf-8`,
`newline=preserve|lf|crlf`.

`append` is computed from the observed blob and is idempotent: when that blob
already ends with the block content, b2f reports `[b2f] append skipped`.

All blocks in one assistant message are one transaction. If any target blob is
stale, nothing commits and feedback includes each stale file's latest complete
content, blob OID, repository revision, and intervening b2f commits. A stale
response becomes the agent's new observation for an immediate retry.

Git index construction and workspace-projection temp files live in
`<root>.b2f-tmp` (or `$DSH_B2F_TMP`), outside the worktree.

## Configuration

```yaml
b2f:
  root: "$WS"                # expands $WS / $DSH_B2F_ROOT; DSH_B2F_ROOT env wins
  maxFileSize: 1048576
  maxTotalSize: 2097152
  maxFilesPerMessage: 16
  diffLineLimit: 200
  canonicalRef: refs/heads/agent-canonical
  maxCasRetries: 8
  tempFileKeep: 16
```

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

The default resolver returns the static `config.root` / `$WS` /
`$DSH_B2F_ROOT` fallback. b2f pins an agent's canonical snapshot when its
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
