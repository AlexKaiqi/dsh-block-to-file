/**
 * Partial-edit resolution for the b2f pipeline.
 *
 * An edit block is a FRONT-END, not a new publication path: this module resolves
 * `(observed content, patch) -> full content`, and the resolved content then
 * travels the same route as any full-content proposal (stale comparison,
 * precondition checks, tree build, ref CAS, worktree projection).
 *
 * Everything here is pure. Resolution runs against the exact bytes of the blob
 * the model observed, never against the worktree and never through Git, so no
 * clean/smudge filter, `core.autocrlf`, or `apply.whitespace` setting can
 * silently transform content on the way in.
 *
 * @module dsh-block-to-file
 */

import { b2fError } from './errors.ts'
import type { B2FError, B2FErrorCode, EditFormat } from './types.ts'

/** Maximum lines a `mode=diff` hunk may drift from its stated start line. */
export const DEFAULT_MAX_DRIFT = 200

/** One resolved span replacement, expressed as absolute offsets into the source. */
interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
  /** Lines between the stated anchor and the matched one; 0 for content anchors. */
  readonly fuzz: number
}

/** Successful resolution of one edit block. */
export interface EditResolution {
  readonly ok: true
  /** Full file content to publish. */
  readonly content: string
  /** Number of edits the block proposed. */
  readonly editsProposed: number
  /** Number of edits applied; equals `editsProposed` on success. */
  readonly editsApplied: number
  /** Largest line drift tolerated across all hunks; 0 for `replace`. */
  readonly fuzz: number
}

/** Failed resolution; no content is produced and nothing may be published. */
export interface EditFailure {
  readonly ok: false
  readonly code: B2FErrorCode
  /** Model-facing explanation, already specific about which edit failed. */
  readonly detail: string
  readonly editsProposed: number
  readonly editsApplied: number
}

export type EditOutcome = EditResolution | EditFailure

/**
 * Resolve one edit block against observed content.
 *
 * @param format - which patch dialect the body is written in.
 * @param body - raw block content exactly as the model wrote it.
 * @param observed - exact text of the blob the model observed.
 * @param maxDrift - line tolerance for `git_diff` anchor search.
 * @returns the full resolved content, or an attributable failure.
 */
export function resolveEdit(
  format: Exclude<EditFormat, 'none'>,
  body: string,
  observed: string,
  maxDrift: number = DEFAULT_MAX_DRIFT,
): EditOutcome {
  return format === 'replace'
    ? resolveReplace(body, observed)
    : resolveGitDiff(body, observed, maxDrift)
}

/** Build the b2f error for a failed resolution. */
export function editError(failure: EditFailure, path: string): B2FError {
  return b2fError(failure.code, path, failure.detail)
}

// ---------------------------------------------------------------------------
// replace backend: SEARCH/REPLACE
// ---------------------------------------------------------------------------

const SEARCH_MARKER = /^<{5,9} SEARCH[ \t]*$/
const DIVIDER_MARKER = /^={5,9}[ \t]*$/
const REPLACE_MARKER = /^>{5,9} REPLACE[ \t]*$/

/** One parsed SEARCH/REPLACE pair. */
interface SearchReplace {
  readonly search: string
  readonly replace: string
}

/**
 * Resolve SEARCH/REPLACE edits.
 *
 * Every SEARCH is matched against the ORIGINAL observed content rather than
 * progressively against partially-edited text, and matched spans must be
 * pairwise disjoint. That makes the result independent of block order and makes
 * every failure attributable to one edit — under sequential application, edit #2
 * failing could be a consequence of edit #1 rather than a fact about edit #2.
 */
function resolveReplace(body: string, observed: string): EditOutcome {
  const parsed = parseSearchReplace(body)
  if (!parsed.ok) return parsed
  const edits = parsed.edits

  const splices: Splice[] = []
  for (const [index, edit] of edits.entries()) {
    const located = locate(observed, edit.search)
    if (located.kind === 'none') {
      return {
        ok: false,
        code: 'EDIT_SEARCH_NOT_FOUND',
        detail: `SEARCH block #${index + 1} does not appear in the file.`,
        editsProposed: edits.length,
        editsApplied: index,
      }
    }
    if (located.kind === 'many') {
      return {
        ok: false,
        code: 'EDIT_SEARCH_AMBIGUOUS',
        detail: `SEARCH block #${index + 1} matches ${located.count} times (lines ${located.lines.join(', ')}).`,
        editsProposed: edits.length,
        editsApplied: index,
      }
    }
    splices.push({
      start: located.start,
      end: located.start + located.length,
      // A normalized match replaces bytes whose line endings differ from the
      // literal SEARCH text, so re-stamp the replacement to match the file.
      text: spliceText(edit.replace, observed, located),
      fuzz: 0,
    })
  }

  return assemble(observed, splices, edits.length, 0, index =>
    `SEARCH blocks #${index} and #${index + 1} overlap.`)
}

/**
 * Shape a REPLACE body to fit the span it is replacing.
 * A style-normalized match needs the replacement re-stamped in the file's line
 * endings; an unterminated match is at end-of-file, so the replacement must not
 * reintroduce a final terminator the file never had.
 */
function spliceText(replaceBody: string, observed: string, located: { normalized: boolean; unterminated: boolean }): string {
  const styled = located.normalized ? restyle(replaceBody, observed) : replaceBody
  return located.unterminated ? stripFinalEol(styled) : styled
}

/** Locate `needle` in `haystack`, tolerating a line-ending mismatch once. */
function locate(haystack: string, needle: string):
  | { kind: 'one'; start: number; length: number; normalized: boolean; unterminated: boolean }
  | { kind: 'none' }
  | { kind: 'many'; count: number; lines: number[] } {
  const exact = allOffsets(haystack, needle)
  if (exact.length === 1) {
    return { kind: 'one', start: exact[0]!, length: needle.length, normalized: false, unterminated: false }
  }
  if (exact.length > 1) {
    return { kind: 'many', count: exact.length, lines: exact.map(offset => lineAt(haystack, offset)) }
  }

  // An empty SEARCH is meaningless and would otherwise "match" everywhere.
  if (needle.length === 0) return { kind: 'none' }

  // The model writes LF; the file may be CRLF (or vice versa). Retry once
  // against a needle re-stamped in the file's dominant style, so the splice
  // still replaces real bytes and surrounding content stays byte-identical.
  const restyled = restyle(needle, haystack)
  if (restyled !== needle) {
    const relaxed = allOffsets(haystack, restyled)
    if (relaxed.length === 1) {
      return { kind: 'one', start: relaxed[0]!, length: restyled.length, normalized: true, unterminated: false }
    }
    if (relaxed.length > 1) {
      return { kind: 'many', count: relaxed.length, lines: relaxed.map(offset => lineAt(haystack, offset)) }
    }
  }

  // `joinBody` terminates every SEARCH section, but the file's last line may
  // have no terminator. Retry unterminated, anchored at end-of-text so this
  // cannot match mid-file where the newline is genuinely absent from the model's
  // text for a different reason.
  const unterminated = stripFinalEol(restyled)
  if (unterminated !== restyled && haystack.endsWith(unterminated)) {
    const start = haystack.length - unterminated.length
    // Still require uniqueness: an earlier occurrence makes the target ambiguous.
    const earlier = allOffsets(haystack, unterminated).filter(offset => offset !== start)
    if (earlier.length > 0) {
      return { kind: 'many', count: earlier.length + 1, lines: [...earlier, start].map(offset => lineAt(haystack, offset)) }
    }
    return { kind: 'one', start, length: unterminated.length, normalized: restyled !== needle, unterminated: true }
  }
  return { kind: 'none' }
}

/** Drop one trailing line terminator, if present. */
function stripFinalEol(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

/** Parse a body into SEARCH/REPLACE pairs, rejecting malformed marker sequences. */
function parseSearchReplace(body: string): { ok: true; edits: SearchReplace[] } | EditFailure {
  const lines = body.split('\n')
  const edits: SearchReplace[] = []
  let state: 'outside' | 'search' | 'replace' = 'outside'
  let search: string[] = []
  let replace: string[] = []

  const fail = (detail: string): EditFailure => ({
    ok: false,
    code: 'EDIT_MALFORMED',
    detail,
    editsProposed: edits.length,
    editsApplied: 0,
  })

  for (const [index, line] of lines.entries()) {
    const at = `line ${index + 1}`
    if (SEARCH_MARKER.test(line)) {
      if (state !== 'outside') return fail(`Unexpected SEARCH marker at ${at} inside an open edit.`)
      state = 'search'
      search = []
      replace = []
      continue
    }
    if (DIVIDER_MARKER.test(line)) {
      if (state !== 'search') return fail(`Unexpected \`=======\` divider at ${at} outside a SEARCH section.`)
      state = 'replace'
      continue
    }
    if (REPLACE_MARKER.test(line)) {
      if (state !== 'replace') return fail(`Unexpected REPLACE marker at ${at} before a \`=======\` divider.`)
      edits.push({ search: joinBody(search), replace: joinBody(replace) })
      state = 'outside'
      continue
    }
    if (state === 'search') search.push(line)
    else if (state === 'replace') replace.push(line)
    else if (line.trim().length > 0) {
      return fail(`Unexpected text at ${at}; content must live inside a SEARCH/REPLACE block.`)
    }
  }

  if (state !== 'outside') return fail('Unterminated edit: expected a `>>>>>>> REPLACE` marker.')
  if (edits.length === 0) {
    return fail('No SEARCH/REPLACE block found; expected `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`.')
  }
  return { ok: true, edits }
}

/**
 * Join marker-delimited section lines back into text.
 * A non-empty section is newline-terminated because it stood on its own lines;
 * an empty section stays empty so an empty REPLACE deletes the matched span.
 */
function joinBody(lines: readonly string[]): string {
  if (lines.length === 0) return ''
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// git_diff backend: hunk-only unified diff
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** One parsed hunk: the stated anchor plus its old/new line bodies. */
interface Hunk {
  /** 1-based old-side start line as stated in the header; a hint only. */
  readonly statedStart: number
  /** Context + deleted lines: what must match the file. */
  readonly oldLines: readonly string[]
  /** Context + added lines: what replaces the match. */
  readonly newLines: readonly string[]
  /** True when the hunk's last old line carried a no-newline-at-EOF marker. */
  readonly oldNoEol: boolean
  /** True when the hunk's last new line carried a no-newline-at-EOF marker. */
  readonly newNoEol: boolean
}

/**
 * Resolve hunk-only unified diff edits.
 *
 * Line counts stated in `@@` headers are ignored and derived from the hunk body
 * instead — the same correction `git apply --recount` makes. The stated start
 * line is treated as a HINT: the anchor is found by searching outward for an
 * exact match of the hunk's old lines, nearest the hint winning. `git apply`
 * cannot recover from a wrong start line at all, and line drift is precisely
 * this dialect's weakness, so tolerating it is the point.
 */
function resolveGitDiff(body: string, observed: string, maxDrift: number): EditOutcome {
  const parsed = parseHunks(body)
  if (!parsed.ok) return parsed
  const hunks = parsed.hunks

  const { lines, eol, trailingNewline, offsets } = splitKeepingStyle(observed)
  const splices: Splice[] = []
  let worstFuzz = 0

  for (const [index, hunk] of hunks.entries()) {
    const found = findAnchor(lines, hunk, maxDrift)
    if (found === null) {
      const stated = hunk.statedStart
      return {
        ok: false,
        code: 'EDIT_CONTEXT_MISMATCH',
        detail: `Hunk #${index + 1} (@@ -${stated}) does not match the file within ${maxDrift} lines of line ${stated}.`,
        editsProposed: hunks.length,
        editsApplied: index,
      }
    }
    worstFuzz = Math.max(worstFuzz, found.fuzz)

    // Offsets are computed over the ORIGINAL text, so every hunk anchors
    // independently and application order cannot shift a later anchor.
    const start = offsetOfLine(offsets, found.line)
    const end = offsetOfLine(offsets, found.line + hunk.oldLines.length)
    const replacesFileEnd = found.line + hunk.oldLines.length >= lines.length
    // Match the terminator actually used at this location, not just the file's
    // dominant one, so an edit inside a mixed-ending region stays consistent.
    const localEol = eolAt(observed, offsets, found.line, eol)
    splices.push({
      start,
      end,
      text: renderLines(hunk.newLines, localEol, replacesFileEnd ? !hunk.newNoEol && trailingNewline : true),
      fuzz: found.fuzz,
    })
  }

  return assemble(observed, splices, hunks.length, worstFuzz, index =>
    `Hunks #${index} and #${index + 1} overlap after anchoring.`)
}

/** Parse a hunk-only unified diff body. */
function parseHunks(body: string): { ok: true; hunks: Hunk[] } | EditFailure {
  const lines = body.split('\n')
  const hunks: Hunk[] = []
  let current: { statedStart: number; oldLines: string[]; newLines: string[]; oldNoEol: boolean; newNoEol: boolean } | null = null
  /** Which side the previous body line belonged to, for a no-newline marker. */
  let lastSide: 'old' | 'new' | 'both' | null = null

  const fail = (detail: string): EditFailure => ({
    ok: false,
    code: 'EDIT_MALFORMED',
    detail,
    editsProposed: hunks.length,
    editsApplied: 0,
  })

  const flush = (): void => {
    if (current === null) return
    hunks.push({
      statedStart: current.statedStart,
      oldLines: current.oldLines,
      newLines: current.newLines,
      oldNoEol: current.oldNoEol,
      newNoEol: current.newNoEol,
    })
    current = null
  }

  for (const [index, line] of lines.entries()) {
    const at = `line ${index + 1}`
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      flush()
      current = { statedStart: Number(header[1]), oldLines: [], newLines: [], oldNoEol: false, newNoEol: false }
      lastSide = null
      continue
    }
    if (current === null) {
      // Tolerate the file headers the model was told to omit, plus blank
      // padding, but never silently drop real content.
      if (line.trim().length === 0) continue
      if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) continue
      return fail(`Unexpected text at ${at} before the first \`@@\` hunk header.`)
    }

    // The last line of a body split on '\n' is an artifact of the block's own
    // trailing newline, not a diff line.
    if (index === lines.length - 1 && line.length === 0) continue

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` annotates the preceding side.
      if (lastSide === 'old' || lastSide === 'both') current.oldNoEol = true
      if (lastSide === 'new' || lastSide === 'both') current.newNoEol = true
      continue
    }

    const marker = line[0]
    const text = line.slice(1)
    if (marker === '-') {
      current.oldLines.push(text)
      lastSide = 'old'
    } else if (marker === '+') {
      current.newLines.push(text)
      lastSide = 'new'
    } else if (marker === ' ') {
      current.oldLines.push(text)
      current.newLines.push(text)
      lastSide = 'both'
    } else if (line.length === 0) {
      // A context line that is itself empty loses its leading space in most
      // editors and model output; treat it as blank context rather than fatal.
      current.oldLines.push('')
      current.newLines.push('')
      lastSide = 'both'
    } else {
      return fail(`Line ${index + 1} starts with ${JSON.stringify(marker)}; diff lines must start with ' ', '-', or '+'.`)
    }
  }
  flush()

  if (hunks.length === 0) return fail('No `@@` hunk header found in the block.')
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.oldLines.length === 0 && hunk.newLines.length === 0) {
      return fail(`Hunk #${index + 1} has no body lines.`)
    }
  }
  return { ok: true, hunks }
}

/**
 * Find a hunk's old-side lines in the file, searching outward from the hint.
 * @returns the 0-based match line and its drift, or null when nothing matches.
 */
function findAnchor(
  lines: readonly string[],
  hunk: Hunk,
  maxDrift: number,
): { line: number; fuzz: number } | null {
  // A pure insertion has no old side to match, so the hint is the anchor.
  if (hunk.oldLines.length === 0) {
    const hinted = clamp(hunk.statedStart - 1, 0, lines.length)
    return { line: hinted, fuzz: 0 }
  }

  // The hint is NOT clamped into range: drift must be measured from the line the
  // model actually claimed, otherwise a wildly wrong header silently reports
  // fuzz 0 and the drift budget stops being enforceable.
  const hinted = hunk.statedStart - 1
  if (matchesAt(lines, hunk.oldLines, hinted)) return { line: hinted, fuzz: 0 }

  // Nearest match wins, so a repeated block resolves to the intended copy.
  for (let drift = 1; drift <= maxDrift; drift++) {
    const before = hinted - drift
    if (matchesAt(lines, hunk.oldLines, before)) return { line: before, fuzz: drift }
    const after = hinted + drift
    if (matchesAt(lines, hunk.oldLines, after)) return { line: after, fuzz: drift }
  }
  return null
}

function matchesAt(lines: readonly string[], needle: readonly string[], start: number): boolean {
  if (start < 0 || start + needle.length > lines.length) return false
  for (let index = 0; index < needle.length; index++) {
    if (lines[start + index] !== needle[index]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// shared splice assembly
// ---------------------------------------------------------------------------

/**
 * Apply resolved splices to the original text.
 * Splices are sorted by position and must not overlap: two edits claiming the
 * same bytes is ambiguous, so it is rejected rather than silently ordered.
 */
function assemble(
  observed: string,
  splices: readonly Splice[],
  editsProposed: number,
  fuzz: number,
  overlapDetail: (index: number) => string,
): EditOutcome {
  const ordered = [...splices]
    .map((splice, index) => ({ splice, index }))
    .sort((left, right) => left.splice.start - right.splice.start || left.index - right.index)

  for (let position = 1; position < ordered.length; position++) {
    const previous = ordered[position - 1]!.splice
    const current = ordered[position]!.splice
    if (current.start < previous.end) {
      return {
        ok: false,
        code: 'EDIT_SPAN_OVERLAP',
        detail: overlapDetail(position),
        editsProposed,
        editsApplied: position,
      }
    }
  }

  let content = ''
  let cursor = 0
  for (const { splice } of ordered) {
    content += observed.slice(cursor, splice.start) + splice.text
    cursor = splice.end
  }
  content += observed.slice(cursor)

  return { ok: true, content, editsProposed, editsApplied: splices.length, fuzz }
}

// ---------------------------------------------------------------------------
// line-ending helpers
// ---------------------------------------------------------------------------

/** Line-oriented view of text that remembers its own line-ending style. */
interface StyledLines {
  readonly lines: readonly string[]
  /** Dominant line terminator, used when rendering replacement lines. */
  readonly eol: string
  readonly trailingNewline: boolean
  /**
   * Byte offset where each line starts in the ORIGINAL text, plus a final entry
   * for end-of-text. Captured during the split rather than recomputed, because a
   * file may mix CRLF and LF and no single terminator length describes it.
   */
  readonly offsets: readonly number[]
}

/**
 * Split text into lines, recording its dominant terminator and true offsets.
 * Every line is stored without its terminator so anchors compare equal
 * regardless of the file's style; `eol` restores that style on output.
 */
function splitKeepingStyle(text: string): StyledLines {
  const eol = dominantEol(text)
  if (text.length === 0) return { lines: [], eol, trailingNewline: false, offsets: [0] }

  const lines: string[] = []
  const offsets: number[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\n') continue
    // A preceding CR belongs to the terminator, not the line.
    const end = index > start && text[index - 1] === '\r' ? index - 1 : index
    lines.push(text.slice(start, end))
    offsets.push(start)
    start = index + 1
  }
  const trailingNewline = start === text.length
  if (!trailingNewline) {
    // Final line without a terminator.
    lines.push(text.slice(start))
    offsets.push(start)
  }
  // Sentinel so a hunk reaching the last line can address end-of-text.
  offsets.push(text.length)
  return { lines, eol, trailingNewline, offsets }
}

/**
 * Byte offset of a 0-based line index in the ORIGINAL text.
 * Indices past the last line resolve to end-of-text, which is what a hunk
 * anchored at the final line needs for its replacement span.
 */
function offsetOfLine(offsets: readonly number[], line: number): number {
  if (line <= 0) return 0
  return line < offsets.length ? offsets[line]! : offsets[offsets.length - 1]!
}

/** Render replacement lines in the file's style. */
function renderLines(lines: readonly string[], eol: string, terminate: boolean): string {
  if (lines.length === 0) return ''
  const body = lines.join(eol)
  return terminate ? body + eol : body
}

/** CRLF when it is the majority terminator, else LF. */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length
  if (crlf === 0) return '\n'
  const lf = (text.match(/\n/g) ?? []).length
  return crlf * 2 > lf ? '\r\n' : '\n'
}

/**
 * Terminator actually ending the given line in the original text.
 * Falls back to the file's dominant style for the final unterminated line.
 */
function eolAt(text: string, offsets: readonly number[], line: number, fallback: string): string {
  const next = line + 1
  if (next >= offsets.length) return fallback
  const end = offsets[next]!
  if (end >= 2 && text.slice(end - 2, end) === '\r\n') return '\r\n'
  if (end >= 1 && text[end - 1] === '\n') return '\n'
  return fallback
}

/** Re-stamp `text`'s line endings in the dominant style of `reference`. */
function restyle(text: string, reference: string): string {
  const eol = dominantEol(reference)
  const normalized = text.replace(/\r\n/g, '\n')
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n')
}

/** Every offset at which `needle` occurs in `haystack`. */
function allOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) return offsets
    offsets.push(found)
    from = found + 1
  }
}

/** 1-based line number of a byte offset. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') line += 1
  }
  return line
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}
