/**
 * Model-visible b2f instructions. This is the ONLY source of the block protocol
 * text the model reads; the pipeline implementation imports and assembles it but
 * never inlines model-facing wording of its own.
 *
 * Exactly one edit dialect is composed into the assembled prompt, so the model
 * never has to decide which patch format to use.
 *
 * @module dsh-block-to-file
 */

import type { EditFormat } from '../types.ts'

/** Full-content protocol, always available regardless of the edit format. */
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
  'Never add file= to example code blocks that are only for display; wrap protocol examples in a longer ordinary fence so they remain inert.',
  'One block per path per message. Every file block in one message must resolve to the same transaction root; split different workspace scopes across messages. Blocks labelled path= in [b2f] feedback are read-only echoes; never copy them back as-is.',
].join('\n')

/** SEARCH/REPLACE protocol, exposed when `editFormat: 'replace'`. */
export const REPLACE_PROMPT = [
  'To change part of an existing file, prefer mode=edit over rewriting the whole file.',
  'The block body is one or more SEARCH/REPLACE pairs:',
  '',
  '```python file=src/client.py mode=edit',
  '<<<<<<< SEARCH',
  '    timeout = 1',
  '=======',
  '    timeout = 3',
  '    retries = 5',
  '>>>>>>> REPLACE',
  '```',
  '',
  'Rules:',
  '- Copy SEARCH text verbatim from the file, including indentation. It must match exactly once.',
  '- If it matches nothing, or matches more than once, nothing is committed. Add surrounding lines until the match is unique.',
  '- An empty REPLACE section deletes the matched text.',
  '- To insert, keep the anchor lines in both sections and add the new lines to REPLACE.',
  '- Several SEARCH/REPLACE pairs may appear in one block; they must target non-overlapping regions.',
  '- Do not add newline= to an edit block; edits keep the file\'s existing line endings.',
].join('\n')

/** Hunk-only unified-diff protocol, exposed when `editFormat: 'git_diff'`. */
export const GIT_DIFF_PROMPT = [
  'To change part of an existing file, prefer mode=diff over rewriting the whole file.',
  'The block body is one or more unified-diff hunks:',
  '',
  '```python file=src/client.py mode=diff',
  '@@ -40,3 +40,4 @@',
  ' def connect():',
  '-    timeout = 1',
  '+    timeout = 3',
  '+    retries = 5',
  '     return client',
  '```',
  '',
  'Rules:',
  '- Emit hunks only. Do not emit `diff --git`, `index`, `---`, or `+++` header lines.',
  '- Every line in a hunk must start with a space (context), `-` (removed), or `+` (added).',
  '- Include 2-3 context lines around each change so the hunk can be located.',
  '- Line numbers in @@ are a hint: the runtime locates the hunk by its context, so small line drift is tolerated. Counts are recomputed and need not be exact.',
  '- If the context does not match the file, nothing is committed and the current content is returned.',
  '- Several hunks may appear in one block; they must target non-overlapping regions.',
  '- Do not add newline= to a diff block; edits keep the file\'s existing line endings.',
].join('\n')

/**
 * Compose the model-facing prompt for one deployment.
 * @param base - the full-content protocol text (configurable).
 * @param editFormat - which edit dialect to expose, if any.
 * @returns the assembled prompt exposing exactly one edit dialect.
 */
export function buildPrompt(base: string, editFormat: EditFormat): string {
  if (editFormat === 'none') return base
  return `${base}\n\n${editFormat === 'replace' ? REPLACE_PROMPT : GIT_DIFF_PROMPT}`
}
