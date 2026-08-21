/**
 * L0 contract tests for the model-visible surface.
 *
 * These assert on the exports in `src/model/` directly, with no host and no
 * repository: whatever the model reads is fixed here. Runtime assembly is
 * covered separately by the L1 cases in `index.spec.ts`.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { BLOCK_FORMS, HELP, PROTOCOL_VERSION, VERSION } from '../src/help.ts'
import { buildPrompt, DEFAULT_PROMPT, GIT_DIFF_PROMPT, REPLACE_PROMPT } from '../src/model/prompt.ts'
import { EDIT_MODE_FOR_FORMAT } from '../src/types.ts'

describe('DEFAULT_PROMPT', () => {
  it('states the block protocol and its attributes', () => {
    expect(DEFAULT_PROMPT).toContain('file=<relative-path>')
    expect(DEFAULT_PROMPT).toContain('mode=write|create|update|append|delete')
    expect(DEFAULT_PROMPT).toContain('one atomic transaction')
    expect(DEFAULT_PROMPT).toContain('same transaction root')
  })

  it('warns against labelling display-only blocks', () => {
    // Without this the model turns illustrative snippets into writes.
    expect(DEFAULT_PROMPT).toContain('Never add file= to example code blocks')
  })

  it('tells the model that path= echoes are read-only', () => {
    // Paired with feedback.ts using path=; both sides must agree or a
    // copied-back echo silently becomes a write proposal.
    expect(DEFAULT_PROMPT).toContain('path=')
    expect(DEFAULT_PROMPT).toContain('read-only echoes')
  })

  it('describes stale handling as reconsider-then-re-emit', () => {
    expect(DEFAULT_PROMPT).toContain('stale')
    expect(DEFAULT_PROMPT).toContain('do not reuse the rejected content blindly')
  })

  it('carries no edit dialect of its own', () => {
    expect(DEFAULT_PROMPT).not.toContain('<<<<<<< SEARCH')
    expect(DEFAULT_PROMPT).not.toContain('@@ -')
  })
})

describe('REPLACE_PROMPT', () => {
  it('names the mode and shows all three markers', () => {
    expect(REPLACE_PROMPT).toContain('mode=edit')
    expect(REPLACE_PROMPT).toContain('<<<<<<< SEARCH')
    expect(REPLACE_PROMPT).toContain('=======')
    expect(REPLACE_PROMPT).toContain('>>>>>>> REPLACE')
  })

  it('states the uniqueness rule the resolver actually enforces', () => {
    expect(REPLACE_PROMPT).toContain('match exactly once')
    expect(REPLACE_PROMPT).toContain('verbatim')
  })

  it('documents deletion, insertion, and non-overlap', () => {
    expect(REPLACE_PROMPT).toContain('empty REPLACE section deletes')
    expect(REPLACE_PROMPT).toContain('To insert')
    expect(REPLACE_PROMPT).toContain('non-overlapping')
  })

  it('forbids newline= so the file keeps its own endings', () => {
    expect(REPLACE_PROMPT).toContain('Do not add newline=')
  })

  it('never mentions the other dialect', () => {
    expect(REPLACE_PROMPT).not.toContain('mode=diff')
    expect(REPLACE_PROMPT).not.toContain('@@ -')
  })
})

describe('GIT_DIFF_PROMPT', () => {
  it('names the mode and shows a hunk header', () => {
    expect(GIT_DIFF_PROMPT).toContain('mode=diff')
    expect(GIT_DIFF_PROMPT).toContain('@@ -40,3 +40,4 @@')
  })

  it('tells the model to omit the file headers the parser tolerates', () => {
    expect(GIT_DIFF_PROMPT).toContain('Emit hunks only')
    expect(GIT_DIFF_PROMPT).toContain('diff --git')
  })

  it('states the line-prefix rule that makes a hunk parseable', () => {
    expect(GIT_DIFF_PROMPT).toContain('must start with a space (context)')
  })

  it('describes @@ numbers as a hint, matching the resolver', () => {
    // The resolver derives counts and searches outward from the hint; the
    // prompt must not promise exactness the implementation does not require.
    expect(GIT_DIFF_PROMPT).toContain('a hint')
    expect(GIT_DIFF_PROMPT).toContain('drift is tolerated')
    expect(GIT_DIFF_PROMPT).toContain('Counts are recomputed')
  })

  it('asks for context lines and forbids newline=', () => {
    expect(GIT_DIFF_PROMPT).toContain('2-3 context lines')
    expect(GIT_DIFF_PROMPT).toContain('Do not add newline=')
  })

  it('never mentions the other dialect', () => {
    expect(GIT_DIFF_PROMPT).not.toContain('mode=edit')
    expect(GIT_DIFF_PROMPT).not.toContain('<<<<<<< SEARCH')
  })
})

describe('buildPrompt', () => {
  it('exposes exactly one dialect per edit format', () => {
    const cases = [
      { format: 'replace', present: '<<<<<<< SEARCH', absent: 'mode=diff' },
      { format: 'git_diff', present: '@@ -40,3 +40,4 @@', absent: '<<<<<<< SEARCH' },
    ] as const
    for (const { format, present, absent } of cases) {
      const text = buildPrompt(DEFAULT_PROMPT, format)
      expect(text).toContain(present)
      expect(text).not.toContain(absent)
    }
  })

  it('exposes no dialect when partial edits are disabled', () => {
    const text = buildPrompt(DEFAULT_PROMPT, 'none')
    expect(text).toBe(DEFAULT_PROMPT)
    expect(text).not.toContain('<<<<<<< SEARCH')
    expect(text).not.toContain('mode=diff')
  })

  it('always keeps the base protocol', () => {
    for (const format of ['replace', 'git_diff', 'none'] as const) {
      expect(buildPrompt(DEFAULT_PROMPT, format)).toContain('file=<relative-path>')
    }
  })

  it('preserves a caller-supplied base verbatim', () => {
    // `prompt` is deployment-configurable; composition must not rewrite it.
    const custom = 'CUSTOM BASE PROTOCOL'
    expect(buildPrompt(custom, 'replace').startsWith(custom)).toBe(true)
  })

  it('advertises the mode each format maps to', () => {
    // Guards against the prompt and the validator gate drifting apart.
    expect(buildPrompt(DEFAULT_PROMPT, 'replace')).toContain(`mode=${EDIT_MODE_FOR_FORMAT.replace}`)
    expect(buildPrompt(DEFAULT_PROMPT, 'git_diff')).toContain(`mode=${EDIT_MODE_FOR_FORMAT.git_diff}`)
  })
})

describe('help surface', () => {
  it('keeps VERSION equal to the package version', async () => {
    // HLP-001 compares these statically; this asserts it at runtime so a
    // release bump that forgets help.ts fails the test process, not just a lint.
    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })

  it('documents every block form the validator accepts', () => {
    // Guards the help surface against drifting from the real mode vocabulary.
    for (const form of BLOCK_FORMS) expect(HELP).toContain(form)
    for (const mode of ['write', 'create', 'update', 'append', 'delete', 'edit', 'diff']) {
      expect(HELP).toContain(mode)
    }
  })

  it('states the protocol version and the read-only echo rule', () => {
    expect(HELP).toContain(PROTOCOL_VERSION)
    expect(HELP).toContain('path=, never file=')
  })

  it('matches the versioned protocol contract file', async () => {
    const contract = JSON.parse(
      await readFile(new URL('../spec/block-protocol.json', import.meta.url), 'utf8'),
    ) as { version: string; blockAttributes: Record<string, unknown> }
    expect(contract.version).toBe(PROTOCOL_VERSION)
    // The contract and the help surface must agree on the attribute vocabulary.
    for (const attribute of Object.keys(contract.blockAttributes)) {
      expect(HELP).toContain(`${attribute}=`)
    }
  })
})
