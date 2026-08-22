/**
 * Small unified-diff generator used by b2f when no git backend is available.
 * The implementation favors correctness and bounded cost over minimal diffs:
 * common prefix/suffix lines are stripped first, then the middle is diffed
 * with an LCS table when small enough, or emitted as one remove/add hunk.
 *
 * @module dsh-block-to-file
 */

/* oxlint-disable typescript/no-non-null-assertion -- LCS table rows are preallocated and indexed in bounds */

export interface DiffHunk {
  readonly header: string
  readonly lines: readonly string[]
}

/** Compute added/removed line counts from rendered diff lines. */
export function countDiffStats(lines: readonly string[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return { added, removed }
}

/**
 * Render a unified diff between two text bodies.
 * @param oldText - previous file content (empty string when absent).
 * @param newText - incoming file content.
 * @param fromFile - left-side file label.
 * @param toFile - right-side file label.
 * @param contextLines - common context lines around each hunk.
 * @returns rendered diff text, or null when the contents are identical.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  fromFile: string,
  toFile: string,
  contextLines = 3,
): string | null {
  if (oldText === newText) return null
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  const hunks: DiffHunk[] = []
  let oldCursor = 0
  let newCursor = 0

  while (oldCursor < oldLines.length && newCursor < newLines.length) {
    const prefix = commonPrefix(oldLines, oldCursor, newLines, newCursor)
    if (prefix > 0) {
      oldCursor += prefix
      newCursor += prefix
      continue
    }
    const suffix = commonSuffix(oldLines, oldCursor, newLines, newCursor)
    const oldEnd = oldLines.length - suffix
    const newEnd = newLines.length - suffix
    const middleOld = oldLines.slice(oldCursor, oldEnd)
    const middleNew = newLines.slice(newCursor, newEnd)
    if (middleOld.length === 0 && middleNew.length === 0) break

    const ops = diffMiddle(middleOld, middleNew)
    const hunkLines = renderHunk(ops, middleOld, middleNew, contextLines)
    const oldRange = formatRange(oldCursor, middleOld.length)
    const newRange = formatRange(newCursor, middleNew.length)
    hunks.push({ header: `@@ -${oldRange} +${newRange} @@`, lines: hunkLines })
    oldCursor = oldEnd
    newCursor = newEnd
  }

  // Trailing-only differences after one side is exhausted.
  if (oldCursor < oldLines.length || newCursor < newLines.length) {
    const middleOld = oldLines.slice(oldCursor)
    const middleNew = newLines.slice(newCursor)
    const ops = diffMiddle(middleOld, middleNew)
    const hunkLines = renderHunk(ops, middleOld, middleNew, contextLines)
    const oldRange = formatRange(oldCursor, middleOld.length)
    const newRange = formatRange(newCursor, middleNew.length)
    hunks.push({ header: `@@ -${oldRange} +${newRange} @@`, lines: hunkLines })
  }

  if (hunks.length === 0) return null
  const body = hunks.map(hunk => `${hunk.header}\n${hunk.lines.join('\n')}`).join('\n')
  return `--- ${fromFile}\n+++ ${toFile}\n${body}`
}

/** Split into lines without trailing empty artifacts; empty text yields []. */
function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function commonPrefix(left: readonly string[], leftStart: number, right: readonly string[], rightStart: number): number {
  let count = 0
  while (leftStart + count < left.length
    && rightStart + count < right.length
    && left[leftStart + count] === right[rightStart + count]) {
    count += 1
  }
  return count
}

function commonSuffix(left: readonly string[], leftStart: number, right: readonly string[], rightStart: number): number {
  let count = 0
  while (count < left.length - leftStart
    && count < right.length - rightStart
    && left[left.length - 1 - count] === right[right.length - 1 - count]) {
    count += 1
  }
  return count
}

type DiffOp = { kind: 'equal'; count: number } | { kind: 'delete'; count: number } | { kind: 'insert'; count: number }

/** Diff two middle slices into equal/delete/insert op runs. */
function diffMiddle(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  if (oldLines.length === 0) return newLines.length === 0 ? [] : [{ kind: 'insert', count: newLines.length }]
  if (newLines.length === 0) return [{ kind: 'delete', count: oldLines.length }]

  // LCS only for small enough inputs; large replacements degrade to one
  // delete + one insert, which is correct and bounded.
  if (oldLines.length * newLines.length <= 4_000_000) {
    const table = lcsTable(oldLines, newLines)
    return backtrack(table, oldLines, newLines)
  }
  return [
    { kind: 'delete', count: oldLines.length },
    { kind: 'insert', count: newLines.length },
  ]
}

function lcsTable(oldLines: readonly string[], newLines: readonly string[]): Uint32Array[] {
  const rows = new Array<Uint32Array>(oldLines.length + 1)
  for (let i = 0; i <= oldLines.length; i++) rows[i] = new Uint32Array(newLines.length + 1)
  for (let i = oldLines.length - 1; i >= 0; i--) {
    const row = rows[i]!
    const next = rows[i + 1]!
    for (let j = newLines.length - 1; j >= 0; j--) {
      row[j] = oldLines[i] === newLines[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }
  return rows
}

function backtrack(table: Uint32Array[], oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      const count = runLength(ops, 'equal', i, j, oldLines, newLines)
      i += count
      j += count
      continue
    }
    if (j < newLines.length && (i === oldLines.length || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      const count = runLength(ops, 'insert', i, j, oldLines, newLines)
      j += count
      continue
    }
    if (i < oldLines.length) {
      const count = runLength(ops, 'delete', i, j, oldLines, newLines)
      i += count
      continue
    }
    if (j < newLines.length) {
      const count = runLength(ops, 'insert', i, j, oldLines, newLines)
      j += count
      continue
    }
  }
  return ops
}

/** Count consecutive lines of the same operation for a compact op run. */
function runLength(
  ops: DiffOp[],
  kind: 'equal' | 'delete' | 'insert',
  oldIndex: number,
  newIndex: number,
  oldLines: readonly string[],
  newLines: readonly string[],
): number {
  const last = ops[ops.length - 1]
  if (last?.kind === kind) {
    last.count += 1
    return 1
  }
  ops.push({ kind, count: 1 })
  void oldIndex
  void newIndex
  void oldLines
  void newLines
  return 1
}

/** Render one hunk body. Equal lines are emitted as context. */
function renderHunk(
  ops: readonly DiffOp[],
  oldLines: readonly string[],
  newLines: readonly string[],
  _contextLines: number,
): string[] {
  const lines: string[] = []
  let oldPos = 0
  let newPos = 0
  for (const op of ops) {
    if (op.kind === 'equal') {
      for (let k = 0; k < op.count; k++) lines.push(` ${oldLines[oldPos + k]}`)
      oldPos += op.count
      newPos += op.count
    } else if (op.kind === 'delete') {
      for (let k = 0; k < op.count; k++) lines.push(`-${oldLines[oldPos + k]}`)
      oldPos += op.count
    } else {
      for (let k = 0; k < op.count; k++) lines.push(`+${newLines[newPos + k]}`)
      newPos += op.count
    }
  }
  return lines
}

/** Format a one-based hunk range as `start` or `start,count`. */
function formatRange(start: number, count: number): string {
  if (count === 0) return `${start},0`
  if (count === 1) return `${start + 1}`
  return `${start + 1},${count}`
}
