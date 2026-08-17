# @deepseek-ai/dsh-block-to-file

Model-facing **block-to-file (b2f)** runtime pipeline plugin.

Fenced code blocks whose info string contains `file=` are materialized into
`$DSH_B2F_ROOT` (configurable via `b2f.root`) before any tool call of the same
assistant message executes. The plugin is **not a tool**: it observes
`session/event` for `assistant/message`, validates and writes synchronously,
then injects a `[b2f]` feedback message for the next step.

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

`append` is idempotent per message: when the target already ends with the
block content, b2f reports `[b2f] append skipped` instead of duplicating.

## Configuration

```yaml
b2f:
  root: "$WS"                # expands $WS / $DSH_B2F_ROOT; DSH_B2F_ROOT env wins
  maxFileSize: 1048576
  maxTotalSize: 2097152
  maxFilesPerMessage: 16
  diffLineLimit: 200
  gitStatusFeedback: true
  tempFileKeep: 16
```

## Environment

| Variable | Purpose |
|---|---|
| `DSH_B2F_ROOT` | workspace root; `file=` paths are relative to it |
| `DSH_B2F_PLUGINS_DIR` | public plugin-artifact root (default `$DSH_B2F_ROOT/plugins`) |
| `DSH_B2F_PRIVATE_DIR` | private plugin state (default `$DSH_B2F_ROOT/.b2f/plugins`) |
| `DSH_B2F_TMP` | atomic-write temp dir (default `$DSH_B2F_ROOT/.b2f/tmp`) |

## Testing

```sh
npx vitest run packages/fs/block-to-file/tests
```

## Usage

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
package intentionally does not patch or remove any official plugin:

```yaml
# in your preset or overlay cordis.yml
- id: str-replace-editor
  disabled: true
```

`tool-bash` remains the single model-facing tool for operating on files.
