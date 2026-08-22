/**
 * Version and command-surface facts for the b2f block protocol.
 *
 * b2f is not a CLI and registers no tool, but it does expose a command surface:
 * the fenced-block syntax the model writes. This module is the single place that
 * states which block forms exist and which protocol version they belong to, so a
 * deployment can answer "what does this b2f accept?" without reading the parser.
 *
 * `VERSION` tracks the package version and is asserted equal to it by the
 * contract tests, so the protocol surface cannot silently drift from a release.
 *
 * @module dsh-block-to-file
 */

/** Package version; kept in lockstep with package.json by contract test. */
export const VERSION = '0.1.0-rc.6'

/** Version of the block protocol described in `spec/block-protocol.json`. */
export const PROTOCOL_VERSION = '1.0.0'

/**
 * Every block form b2f accepts, as the model would write it.
 *
 * Partial-edit forms are listed for completeness; a deployment exposes exactly
 * one of them, chosen by `editFormat`, and rejects the other.
 */
export const HELP = `b2f block protocol ${PROTOCOL_VERSION} (dsh-block-to-file ${VERSION})

Blocks are written in assistant messages, not called as a tool. Every block in
one message commits together, before any tool call in that message runs.

forms:
  \`\`\`<lang> file=<path>                    write full content (default)
  \`\`\`<lang> file=<path> mode=create        create; fails if the path exists
  \`\`\`<lang> file=<path> mode=update        update; fails if the path is absent
  \`\`\`<lang> file=<path> mode=append        append; idempotent
  \`\`\`<lang> file=<path> mode=delete        delete; body must be empty
  \`\`\`<lang> file=<path> mode=edit          SEARCH/REPLACE edit (editFormat=replace)
  \`\`\`<lang> file=<path> mode=diff          hunk-only unified diff (editFormat=git_diff)

attributes:
  file=<path>                required; repository-relative
  mode=<form>                default write
  diff=full|limited|stats|none   feedback detail, default limited
  encoding=utf-8             only utf-8 is supported
  newline=preserve|lf|crlf   default preserve; rejected on edit and diff

feedback:
  [b2f] committed | unchanged | stale | precondition failed
  [b2f] worktree dirty | edit not applied | error
  Content echoed back is labelled path=, never file=; echoes are read-only and
  must not be copied back as write proposals.
`

/** Declared block forms, for assertions and deployment introspection. */
export const BLOCK_FORMS = [
  'file=<path>',
  'file=<path> mode=create',
  'file=<path> mode=update',
  'file=<path> mode=append',
  'file=<path> mode=delete',
  'file=<path> mode=edit',
  'file=<path> mode=diff',
] as const
