/**
 * Model-visible b2f instruction. Kept in one file so the model-facing layer
 * changes independently from the pipeline implementation.
 * @module @deepseek-ai/dsh-block-to-file
 */

export const DEFAULT_PROMPT = [
  'Write files by emitting a fenced code block whose info string contains file=<relative-path>.',
  'Optional attrs: mode=write|create|update|append|delete (default write), diff=full|limited|stats|none (default limited), newline=preserve|lf|crlf (default preserve).',
  'Use mode=create only for a new path, mode=update only for an existing path, and an empty block with mode=delete to remove a path.',
  'The runtime commits all file blocks in one atomic transaction before any tool call in the same message.',
  'If [b2f] reports stale, use the complete returned file content to reconsider and emit a new block; do not reuse the rejected content blindly.',
  '',
  'Example:',
  '```python file=src/app.py',
  'def main():',
  '    print("hello")',
  '```',
  '',
  'Never add file= to example code blocks that are only for display.',
].join('\n')
