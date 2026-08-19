import { describe, expect, it } from 'vitest'
import { resolveEdit } from '../src/edit.ts'
import type { EditOutcome } from '../src/edit.ts'

/** Assert success and return the resolved content. */
function resolved(outcome: EditOutcome): string {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.detail}`)
  return outcome.content
}

/** Assert failure and return the error code. */
function failed(outcome: EditOutcome): string {
  if (outcome.ok) throw new Error(`expected failure, got content ${JSON.stringify(outcome.content)}`)
  return outcome.code
}

function replace(body: string, observed: string): EditOutcome {
  return resolveEdit('replace', body, observed)
}

function gitDiff(body: string, observed: string, maxDrift?: number): EditOutcome {
  return resolveEdit('git_diff', body, observed, maxDrift)
}

const CLIENT = [
  'import os',
  '',
  'def connect():',
  '    timeout = 1',
  '    return client',
  '',
].join('\n')

describe('replace backend', () => {
  it('replaces a uniquely matched span', () => {
    const outcome = replace(
      '<<<<<<< SEARCH\n    timeout = 1\n=======\n    timeout = 3\n    retries = 5\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect():\n    timeout = 3\n    retries = 5\n    return client\n',
    )
  })

  it('reports edit counts on success', () => {
    const outcome = replace(
      '<<<<<<< SEARCH\nimport os\n=======\nimport sys\n>>>>>>> REPLACE\n'
      + '<<<<<<< SEARCH\n    return client\n=======\n    return conn\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    expect(outcome).toMatchObject({ ok: true, editsProposed: 2, editsApplied: 2, fuzz: 0 })
  })

  it('inserts by keeping the anchor in the replacement', () => {
    const outcome = replace(
      '<<<<<<< SEARCH\n    timeout = 1\n    return client\n=======\n    timeout = 1\n    retries = 5\n    return client\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect():\n    timeout = 1\n    retries = 5\n    return client\n',
    )
  })

  it('deletes the matched span when REPLACE is empty', () => {
    const outcome = replace('<<<<<<< SEARCH\n    timeout = 1\n=======\n>>>>>>> REPLACE\n', CLIENT)
    expect(resolved(outcome)).toBe('import os\n\ndef connect():\n    return client\n')
  })

  it('applies multiple edits independent of their written order', () => {
    const forward = replace(
      '<<<<<<< SEARCH\nimport os\n=======\nimport sys\n>>>>>>> REPLACE\n'
      + '<<<<<<< SEARCH\n    return client\n=======\n    return conn\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    const reversed = replace(
      '<<<<<<< SEARCH\n    return client\n=======\n    return conn\n>>>>>>> REPLACE\n'
      + '<<<<<<< SEARCH\nimport os\n=======\nimport sys\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    expect(resolved(forward)).toBe('import sys\n\ndef connect():\n    timeout = 1\n    return conn\n')
    expect(resolved(reversed)).toBe(resolved(forward))
  })

  it('rejects a SEARCH block that does not appear', () => {
    const outcome = replace('<<<<<<< SEARCH\n    timeout = 99\n=======\n    timeout = 3\n>>>>>>> REPLACE\n', CLIENT)
    expect(failed(outcome)).toBe('EDIT_SEARCH_NOT_FOUND')
  })

  it('rejects an ambiguous SEARCH block and names the matching lines', () => {
    const repeated = 'a = 1\nb = 2\na = 1\n'
    const outcome = replace('<<<<<<< SEARCH\na = 1\n=======\na = 9\n>>>>>>> REPLACE\n', repeated)
    expect(failed(outcome)).toBe('EDIT_SEARCH_AMBIGUOUS')
    if (outcome.ok) return
    expect(outcome.detail).toContain('matches 2 times')
    expect(outcome.detail).toContain('lines 1, 3')
  })

  it('rejects two edits claiming overlapping spans', () => {
    const outcome = replace(
      '<<<<<<< SEARCH\n    timeout = 1\n    return client\n=======\n    timeout = 2\n    return client\n>>>>>>> REPLACE\n'
      + '<<<<<<< SEARCH\n    return client\n=======\n    return conn\n>>>>>>> REPLACE\n',
      CLIENT,
    )
    expect(failed(outcome)).toBe('EDIT_SPAN_OVERLAP')
  })

  it('preserves CRLF when the SEARCH block is written with LF', () => {
    const crlf = 'import os\r\n\r\ndef connect():\r\n    timeout = 1\r\n    return client\r\n'
    const outcome = replace('<<<<<<< SEARCH\n    timeout = 1\n=======\n    timeout = 3\n    retries = 5\n>>>>>>> REPLACE\n', crlf)
    expect(resolved(outcome)).toBe(
      'import os\r\n\r\ndef connect():\r\n    timeout = 3\r\n    retries = 5\r\n    return client\r\n',
    )
  })

  it('edits a file with no trailing newline without adding one', () => {
    const outcome = replace('<<<<<<< SEARCH\nb = 2\n=======\nb = 3\n>>>>>>> REPLACE\n', 'a = 1\nb = 2')
    expect(resolved(outcome)).toBe('a = 1\nb = 3')
  })

  it('rejects malformed marker sequences', () => {
    expect(failed(replace('<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(replace('=======\na\n>>>>>>> REPLACE\n', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(replace('<<<<<<< SEARCH\na\n=======\nb\n', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(replace('just some prose\n', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(replace('', CLIENT))).toBe('EDIT_MALFORMED')
  })

  it('rejects an empty SEARCH block rather than matching everywhere', () => {
    expect(failed(replace('<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n', CLIENT))).toBe('EDIT_SEARCH_NOT_FOUND')
  })
})

describe('git_diff backend', () => {
  it('applies a hunk at its stated position', () => {
    const outcome = gitDiff(
      '@@ -3,3 +3,4 @@\n def connect():\n-    timeout = 1\n+    timeout = 3\n+    retries = 5\n     return client\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect():\n    timeout = 3\n    retries = 5\n    return client\n',
    )
  })

  it('ignores wrong line counts in the hunk header', () => {
    const outcome = gitDiff(
      '@@ -3,99 +3,1 @@\n def connect():\n-    timeout = 1\n+    timeout = 3\n     return client\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe('import os\n\ndef connect():\n    timeout = 3\n    return client\n')
  })

  it('accepts a header with no counts at all', () => {
    const outcome = gitDiff('@@ -4 +4 @@\n-    timeout = 1\n+    timeout = 3\n', CLIENT)
    expect(resolved(outcome)).toBe('import os\n\ndef connect():\n    timeout = 3\n    return client\n')
  })

  it('recovers from a wrong start line within the drift budget', () => {
    // Claims line 40; the real anchor is line 4.
    const outcome = gitDiff(
      '@@ -40,3 +40,4 @@\n def connect():\n-    timeout = 1\n+    timeout = 3\n+    retries = 5\n     return client\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect():\n    timeout = 3\n    retries = 5\n    return client\n',
    )
    if (!outcome.ok) return
    expect(outcome.fuzz).toBeGreaterThan(0)
  })

  it('rejects a start line beyond the drift budget', () => {
    const outcome = gitDiff(
      '@@ -400,3 +400,4 @@\n def connect():\n-    timeout = 1\n+    timeout = 3\n     return client\n',
      CLIENT,
      2,
    )
    expect(failed(outcome)).toBe('EDIT_CONTEXT_MISMATCH')
  })

  it('anchors a repeated block to the copy nearest the stated line', () => {
    const repeated = ['x = 0', 'a = 1', 'y = 0', 'a = 1', 'z = 0', ''].join('\n')
    const outcome = gitDiff('@@ -4,1 +4,1 @@\n-a = 1\n+a = 9\n', repeated)
    expect(resolved(outcome)).toBe('x = 0\na = 1\ny = 0\na = 9\nz = 0\n')
  })

  it('reports context mismatch when the anchor text is wrong', () => {
    const outcome = gitDiff('@@ -3,2 +3,2 @@\n def connect():\n-    timeout = 99\n+    timeout = 3\n', CLIENT)
    expect(failed(outcome)).toBe('EDIT_CONTEXT_MISMATCH')
  })

  it('applies several hunks in one block', () => {
    const outcome = gitDiff(
      '@@ -1,1 +1,1 @@\n-import os\n+import sys\n'
      + '@@ -5,1 +5,1 @@\n-    return client\n+    return conn\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe('import sys\n\ndef connect():\n    timeout = 1\n    return conn\n')
    expect(outcome).toMatchObject({ editsProposed: 2, editsApplied: 2 })
  })

  it('rejects hunks that overlap after anchoring', () => {
    const outcome = gitDiff(
      '@@ -4,2 +4,2 @@\n-    timeout = 1\n-    return client\n+    timeout = 2\n+    return client\n'
      + '@@ -5,1 +5,1 @@\n-    return client\n+    return conn\n',
      CLIENT,
    )
    expect(failed(outcome)).toBe('EDIT_SPAN_OVERLAP')
  })

  it('treats a blank context line missing its leading space as context', () => {
    const outcome = gitDiff('@@ -1,3 +1,3 @@\n import os\n\n-def connect():\n+def connect(url):\n', CLIENT)
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect(url):\n    timeout = 1\n    return client\n',
    )
  })

  it('applies a pure deletion hunk', () => {
    const outcome = gitDiff('@@ -4,1 +4,0 @@\n-    timeout = 1\n', CLIENT)
    expect(resolved(outcome)).toBe('import os\n\ndef connect():\n    return client\n')
  })

  it('applies a pure insertion hunk', () => {
    const outcome = gitDiff('@@ -4,2 +4,3 @@\n     timeout = 1\n+    retries = 5\n     return client\n', CLIENT)
    expect(resolved(outcome)).toBe(
      'import os\n\ndef connect():\n    timeout = 1\n    retries = 5\n    return client\n',
    )
  })

  it('preserves CRLF when the hunk is written with LF', () => {
    const crlf = 'import os\r\n\r\ndef connect():\r\n    timeout = 1\r\n    return client\r\n'
    const outcome = gitDiff('@@ -4,1 +4,2 @@\n-    timeout = 1\n+    timeout = 3\n+    retries = 5\n', crlf)
    expect(resolved(outcome)).toBe(
      'import os\r\n\r\ndef connect():\r\n    timeout = 3\r\n    retries = 5\r\n    return client\r\n',
    )
  })

  it('keeps a missing trailing newline missing when editing the last line', () => {
    const outcome = gitDiff('@@ -2,1 +2,1 @@\n-b = 2\n+b = 3\n', 'a = 1\nb = 2')
    expect(resolved(outcome)).toBe('a = 1\nb = 3')
  })

  it('honors an explicit no-newline marker on the new side', () => {
    const outcome = gitDiff('@@ -2,1 +2,1 @@\n-b = 2\n+b = 3\n\\ No newline at end of file\n', 'a = 1\nb = 2\n')
    expect(resolved(outcome)).toBe('a = 1\nb = 3')
  })

  it('tolerates the file headers the model was told to omit', () => {
    const outcome = gitDiff(
      'diff --git a/src/client.py b/src/client.py\n--- a/src/client.py\n+++ b/src/client.py\n'
      + '@@ -4,1 +4,1 @@\n-    timeout = 1\n+    timeout = 3\n',
      CLIENT,
    )
    expect(resolved(outcome)).toBe('import os\n\ndef connect():\n    timeout = 3\n    return client\n')
  })

  it('rejects malformed bodies', () => {
    expect(failed(gitDiff('', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(gitDiff('no hunk header here\n', CLIENT))).toBe('EDIT_MALFORMED')
    expect(failed(gitDiff('@@ -1,1 +1,1 @@\n', CLIENT))).toBe('EDIT_MALFORMED')
    // A non-empty context line missing its leading space is indistinguishable
    // from a corrupt patch, exactly as `git apply` treats it.
    expect(failed(gitDiff('@@ -1,2 +1,2 @@\nimport os\n-def connect():\n+def connect(url):\n', CLIENT)))
      .toBe('EDIT_MALFORMED')
  })

  it('edits a mixed-ending file without disturbing other lines', () => {
    // Line 3 is CRLF-terminated; the rest LF. Byte offsets cannot be derived
    // from a single terminator length, so they must be captured while splitting.
    const mixed = 'a\nb\nc\r\nd\n'
    expect(resolved(gitDiff('@@ -4,1 +4,1 @@\n-d\n+D\n', mixed))).toBe('a\nb\nc\r\nD\n')
    expect(resolved(gitDiff('@@ -1,1 +1,1 @@\n-a\n+A\n', mixed))).toBe('A\nb\nc\r\nd\n')
  })

  it('keeps a CRLF line CRLF when editing it inside a mixed file', () => {
    const mixed = 'a\nb\nc\r\nd\n'
    expect(resolved(gitDiff('@@ -3,1 +3,1 @@\n-c\n+C\n', mixed))).toBe('a\nb\nC\r\nd\n')
  })

  it('applies several hunks to a mixed-ending file', () => {
    const mixed = 'a\nb\r\nc\nd\r\ne\n'
    const outcome = gitDiff('@@ -1,1 +1,1 @@\n-a\n+A\n@@ -4,1 +4,1 @@\n-d\n+D\n', mixed)
    expect(resolved(outcome)).toBe('A\nb\r\nc\nD\r\ne\n')
  })
})
