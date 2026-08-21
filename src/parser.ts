/**
 * Fenced-code-block parser for the b2f pipeline.
 *
 * The parser scans assistant text for GFM-style fenced code blocks and keeps
 * only the blocks whose info string contains a `file=` attribute. Attribute
 * syntax errors are collected per block and reported together with validation
 * errors by the pipeline.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { ERROR_HINTS, type B2FError, type FileBlock, type FileBlockNewline } from './types.ts'

const KNOWN_ATTRS = new Set(['file', 'mode', 'diff', 'encoding', 'newline'])

/** Parsed attribute map plus any attribute-level errors. */
interface ParsedInfo {
  readonly lang: string | null
  readonly attrs: Map<string, string>
  readonly errors: readonly B2FError[]
}

/** Result of one full parse over an assistant text. */
export interface ParseResult {
  readonly blocks: readonly FileBlock[]
  readonly errors: readonly B2FError[]
}

/**
 * Parse all file blocks from assistant message text.
 * Content is preserved character-for-character, including trailing newlines,
 * because the parser works on raw string offsets rather than line splits.
 *
 * @param text - concatenated assistant text content blocks.
 * @returns file blocks in message order and all attribute-level errors.
 */
export function parseFileBlocks(text: string, defaultNewline: FileBlockNewline = 'preserve'): ParseResult {
  const blocks: FileBlock[] = []
  const errors: B2FError[] = []
  let pos = 0
  let index = 0

  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos)
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd)
    const nextPos = lineEnd === -1 ? text.length : lineEnd + 1

    const fence = openingFence(line)
    if (fence === undefined) {
      pos = nextPos
      continue
    }

    const info = line.slice(fence.infoStart).trimEnd()
    const parsed = parseInfoString(info)
    if (!parsed.attrs.has('file')) {
      // A display-only fence is opaque. In particular, documentation examples
      // containing an inner `file=` fence must not become write instructions.
      pos = skipToClosingFence(text, nextPos, fence.markerLength)
      continue
    }

    for (const error of parsed.errors) errors.push(error)
    const rawPath = parsed.attrs.get('file')
    if (rawPath === undefined || parsed.errors.some(error => error.code === 'UNKNOWN_ATTR' || error.code === 'DUPLICATE_ATTR')) {
      // Skip malformed blocks; later sibling blocks still parse. Unclosed
      // malformed blocks consume the rest of the text.
      pos = skipToClosingFence(text, nextPos, fence.markerLength)
      continue
    }

    const closing = findClosingFence(text, nextPos, fence.markerLength)
    if (closing === undefined) {
      // Unclosed file block: treat the rest of the text as content.
      blocks.push(buildBlock(parsed, rawPath, text.slice(nextPos), defaultNewline, index++))
      break
    }

    blocks.push(buildBlock(parsed, rawPath, text.slice(nextPos, closing.start), defaultNewline, index++))
    pos = closing.next
  }

  return { blocks, errors }
}

/** Build a FileBlock from parsed attributes, keeping raw attribute values for the validator. */
function buildBlock(parsed: ParsedInfo, rawPath: string, content: string, defaultNewline: FileBlockNewline, index: number): FileBlock {
  return {
    path: rawPath,
    content,
    mode: parsed.attrs.get('mode') ?? 'write',
    diff: parsed.attrs.get('diff') ?? 'limited',
    encoding: parsed.attrs.get('encoding') ?? 'utf-8',
    newline: parsed.attrs.get('newline') ?? defaultNewline,
    newlineExplicit: parsed.attrs.has('newline'),
    lang: parsed.lang,
    index,
  }
}

/** Opening-fence shape, or undefined when the line does not open a fenced block. */
function openingFence(line: string): { infoStart: number; markerLength: number } | undefined {
  const match = /^ {0,3}(`{3,})/.exec(line)
  if (match === null) return undefined
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the capture group exists whenever the fence regex matches
  return { infoStart: match[0].length, markerLength: match[1]!.length }
}

interface ClosingFence {
  /** Character offset where the closing fence line begins. */
  readonly start: number
  /** Character offset just past the closing fence line (after its newline). */
  readonly next: number
}

/**
 * Find the closing fence starting at or after `startPos`. Returns undefined
 * when no closing fence exists before EOF.
 */
function findClosingFence(text: string, startPos: number, markerLength: number): ClosingFence | undefined {
  let pos = startPos
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos)
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd)
    const next = lineEnd === -1 ? text.length : lineEnd + 1
    const match = /^ {0,3}(`{3,})[ \t]*$/.exec(line)
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the capture group exists whenever the fence regex matches
    if (match !== null && match[1]!.length >= markerLength) {
      return { start: pos, next }
    }
    pos = next
  }
  return undefined
}

/**
 * Advance past a malformed block's closing fence so later sibling blocks still
 * parse. Unclosed malformed blocks consume the rest of the text.
 */
function skipToClosingFence(text: string, startPos: number, markerLength: number): number {
  const closing = findClosingFence(text, startPos, markerLength)
  return closing === undefined ? text.length : closing.next
}

/**
 * Parse an info string into an optional language tag and attribute map.
 * Attribute syntax is whitespace-separated `key=value`; the first bare token
 * is the language tag. Unknown or duplicate attributes produce errors.
 */
function parseInfoString(info: string): ParsedInfo {
  const attrs = new Map<string, string>()
  const errors: B2FError[] = []
  let lang: string | null = null
  const tokens = info.trim().split(/\s+/).filter(token => token.length > 0)

  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq === -1) {
      if (lang === null && attrs.size === 0) {
        lang = token
        continue
      }
      errors.push(attrError('UNKNOWN_ATTR', token, attrs.get('file') ?? null))
      continue
    }
    if (eq === 0) {
      errors.push(attrError('UNKNOWN_ATTR', token, attrs.get('file') ?? null))
      continue
    }
    const key = token.slice(0, eq)
    const value = token.slice(eq + 1)
    if (value.length === 0) {
      errors.push(attrError('UNKNOWN_ATTR', token, attrs.get('file') ?? null))
      continue
    }
    if (!KNOWN_ATTRS.has(key)) {
      errors.push(attrError('UNKNOWN_ATTR', token, attrs.get('file') ?? null))
      continue
    }
    if (attrs.has(key)) {
      errors.push(attrError('DUPLICATE_ATTR', token, attrs.get('file') ?? null))
      continue
    }
    attrs.set(key, value)
  }

  return { lang, attrs, errors }
}

function attrError(code: 'UNKNOWN_ATTR' | 'DUPLICATE_ATTR', token: string, path: string | null): B2FError {
  return {
    code,
    path,
    hint: `${ERROR_HINTS[code]} (got ${JSON.stringify(token)})`,
  }
}
