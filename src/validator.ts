/**
 * Pure validation for parsed file blocks. Validation performs checks only;
 * no directory or file is created or modified here.
 *
 * @module dsh-block-to-file
 */

import { posix } from 'node:path'
import { EDIT_MODE_FOR_FORMAT, ERROR_HINTS, type B2FError, type EditFormat, type FileBlock } from './types.ts'

/** Resolved configuration for one b2f pipeline run. */
export interface B2FValidationConfig {
  readonly root: string
  readonly maxFileSize: number
  readonly maxTotalSize: number
  readonly maxFilesPerMessage: number
  /**
   * Which edit dialect this deployment exposes. Optional so the pure validator
   * stays usable without deployment config; omitted means no partial edits.
   */
  readonly editFormat?: EditFormat | undefined
}

/** One validated block with its normalized path and raw content. */
export interface ValidatedFileBlock {
  readonly block: FileBlock
  readonly normalizedPath: string
  /** Absolute target path inside root, safe after lexical sandbox checks. */
  readonly targetPath: string
  /** Byte length of the UTF-8 encoded content. */
  readonly byteLength: number
}

/** Validation outcome. */
export interface ValidationResult {
  readonly valid: boolean
  readonly validated: readonly ValidatedFileBlock[]
  readonly errors: readonly B2FError[]
}

const MODES = new Set(['write', 'create', 'update', 'append', 'delete', 'edit', 'diff'])
const DIFFS = new Set(['full', 'limited', 'stats', 'none'])
const NEWLINES = new Set(['preserve', 'lf', 'crlf'])
/** Modes whose body is a patch rather than file content. */
const EDIT_MODES = new Set<string>(Object.values(EDIT_MODE_FOR_FORMAT))

/**
 * Validate every file block in one assistant message.
 * @param blocks - parsed file blocks in message order.
 * @param config - root and limits for this run.
 * @returns validated blocks, or the full error list when anything failed.
 */
export function validateFileBlocks(
  blocks: readonly FileBlock[],
  config: B2FValidationConfig,
): ValidationResult {
  const errors: B2FError[] = []
  const validated: ValidatedFileBlock[] = []
  const seen = new Map<string, number>()

  const normalized: { block: FileBlock; normalizedPath: string; targetPath: string }[] = []
  for (const block of blocks) {
    const normalizedPath = normalizePath(block.path, errors)
    if (normalizedPath === null) continue
    const targetPath = posix.join(config.root, normalizedPath)
    normalized.push({ block, normalizedPath, targetPath })

    const previous = seen.get(normalizedPath)
    if (previous !== undefined) {
      errors.push({
        code: 'DUPLICATE_PATH',
        path: block.path,
        hint: `${ERROR_HINTS.DUPLICATE_PATH} (first seen at block #${previous + 1})`,
      })
    } else {
      seen.set(normalizedPath, block.index)
    }
  }

  let totalBytes = 0
  for (const entry of normalized) {
    const { block, normalizedPath, targetPath } = entry
    const byteLength = Buffer.byteLength(block.content, 'utf8')
    totalBytes += byteLength

    if (!MODES.has(block.mode)) {
      errors.push({
        code: 'INVALID_MODE',
        path: block.path,
        hint: `${ERROR_HINTS.INVALID_MODE} (got ${JSON.stringify(block.mode)})`,
      })
    }
    if (!DIFFS.has(block.diff)) {
      errors.push({
        code: 'INVALID_DIFF',
        path: block.path,
        hint: `${ERROR_HINTS.INVALID_DIFF} (got ${JSON.stringify(block.diff)})`,
      })
    }
    if (block.encoding !== 'utf-8') {
      errors.push({
        code: 'INVALID_ENCODING',
        path: block.path,
        hint: `${ERROR_HINTS.INVALID_ENCODING} (got ${JSON.stringify(block.encoding)})`,
      })
    }
    if (!NEWLINES.has(block.newline)) {
      errors.push({
        code: 'INVALID_NEWLINE',
        path: block.path,
        hint: `${ERROR_HINTS.INVALID_NEWLINE} (got ${JSON.stringify(block.newline)})`,
      })
    }
    if (block.mode === 'delete' && block.content.length > 0) {
      errors.push({
        code: 'DELETE_CONTENT',
        path: block.path,
        hint: ERROR_HINTS.DELETE_CONTENT,
      })
    }
    if (EDIT_MODES.has(block.mode)) {
      const active = config.editFormat ?? 'none'
      const expected = active === 'none' ? null : EDIT_MODE_FOR_FORMAT[active]
      if (block.mode !== expected) {
        errors.push({
          code: 'EDIT_MODE_DISABLED',
          path: block.path,
          hint: expected === null
            ? `${ERROR_HINTS.EDIT_MODE_DISABLED} (partial edits are disabled; emit the full file content instead)`
            : `${ERROR_HINTS.EDIT_MODE_DISABLED} (got mode=${block.mode}; this deployment uses mode=${expected})`,
        })
      }
      if (block.content.trim().length === 0) {
        errors.push({ code: 'EDIT_EMPTY', path: block.path, hint: ERROR_HINTS.EDIT_EMPTY })
      }
      // An edit resolves against the observed bytes and preserves the file's own
      // line endings. Only an EXPLICIT newline= is an error: the deployment
      // default is stamped on every block by the parser and must not reject one.
      if (block.newlineExplicit) {
        errors.push({ code: 'EDIT_NEWLINE_ATTR', path: block.path, hint: ERROR_HINTS.EDIT_NEWLINE_ATTR })
      }
    }
    if (!isWellFormedUtf16(block.content)) {
      errors.push({
        code: 'ENCODING_INVALID',
        path: block.path,
        hint: ERROR_HINTS.ENCODING_INVALID,
      })
    }
    if (byteLength > config.maxFileSize) {
      errors.push({
        code: 'SIZE_EXCEEDED',
        path: block.path,
        hint: `${ERROR_HINTS.SIZE_EXCEEDED} (${byteLength} bytes, limit ${config.maxFileSize})`,
      })
    }
    validated.push({ block, normalizedPath, targetPath, byteLength })
  }

  if (normalized.length > config.maxFilesPerMessage) {
    errors.push({
      code: 'TOO_MANY_FILES',
      path: null,
      hint: `${ERROR_HINTS.TOO_MANY_FILES} (${normalized.length} blocks, limit ${config.maxFilesPerMessage})`,
    })
  }
  if (totalBytes > config.maxTotalSize) {
    errors.push({
      code: 'TOTAL_SIZE_EXCEEDED',
      path: null,
      hint: `${ERROR_HINTS.TOTAL_SIZE_EXCEEDED} (${totalBytes} bytes, limit ${config.maxTotalSize})`,
    })
  }

  const dedupedErrors = dedupeErrors(errors)
  return {
    valid: dedupedErrors.length === 0,
    validated,
    errors: dedupedErrors,
  }
}

/**
 * Lexically normalize and sandbox one `file=` path.
 * @returns the POSIX-normalized relative path, or null when the path is rejected.
 */
function normalizePath(rawPath: string, errors: B2FError[]): string | null {
  if (rawPath.length === 0) {
    errors.push({ code: 'PATH_REQUIRED', path: rawPath, hint: ERROR_HINTS.PATH_REQUIRED })
    return null
  }
  if (rawPath.includes('\0')) {
    errors.push({ code: 'PATH_ESCAPE', path: rawPath, hint: `${ERROR_HINTS.PATH_ESCAPE} (NUL byte rejected)` })
    return null
  }

  const slashed = rawPath.replaceAll('\\', '/')
  if (slashed.startsWith('/')) {
    errors.push({ code: 'PATH_ABSOLUTE', path: rawPath, hint: ERROR_HINTS.PATH_ABSOLUTE })
    return null
  }
  if (/^[A-Za-z]:/.test(slashed)) {
    errors.push({ code: 'PATH_ABSOLUTE', path: rawPath, hint: ERROR_HINTS.PATH_ABSOLUTE })
    return null
  }

  const segments = slashed.split('/')
  if (segments.some(segment => segment === '.' || segment === '..')) {
    errors.push({ code: 'PATH_ESCAPE', path: rawPath, hint: ERROR_HINTS.PATH_ESCAPE })
    return null
  }

  const normalized = posix.normalize(slashed)
  if (normalized === '..' || normalized.startsWith('../') || normalized === '') {
    errors.push({ code: 'PATH_ESCAPE', path: rawPath, hint: ERROR_HINTS.PATH_ESCAPE })
    return null
  }
  return normalized
}

/** True when the string contains only valid Unicode code points, i.e. no lone surrogates. */
function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

/** Drop duplicate errors for the same path so a single malformed block reports once. */
function dedupeErrors(errors: readonly B2FError[]): B2FError[] {
  const seen = new Set<string>()
  const deduped: B2FError[] = []
  for (const error of errors) {
    const key = `${error.code}:${error.path ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(error)
  }
  return deduped
}
