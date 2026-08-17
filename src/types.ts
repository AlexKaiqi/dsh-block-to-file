/**
 * Shared vocabulary for the block-to-file (b2f) runtime pipeline.
 * @module @deepseek-ai/dsh-block-to-file
 */

/** Valid block materialization modes. */
export type FileBlockMode = 'write' | 'create' | 'append'

/** Valid diff feedback strategies. */
export type FileBlockDiff = 'full' | 'limited' | 'stats' | 'none'

/** Valid content encodings (UTF-8 only in MVP). */
export type FileBlockEncoding = 'utf-8'

/** Valid newline policies. */
export type FileBlockNewline = 'preserve' | 'lf' | 'crlf'

/** One parsed file block extracted from an assistant message. */
export interface FileBlock {
  /** Raw `file=` attribute value, as written by the model. */
  readonly path: string
  /** Block content exactly as written, before newline conversion. */
  readonly content: string
  /** Raw `mode=` attribute value, validated later. */
  readonly mode: string
  /** Raw `diff=` attribute value, validated later. */
  readonly diff: string
  /** Raw `encoding=` attribute value, validated later. */
  readonly encoding: string
  /** Raw `newline=` attribute value, validated later. */
  readonly newline: string
  /** Language tag from the info string, when present; informational only. */
  readonly lang: string | null
  /** Zero-based occurrence order within the assistant message. */
  readonly index: number
}

/** Stable machine-routing error codes, one entry per failed block. */
export type B2FErrorCode =
  | 'PATH_REQUIRED'
  | 'PATH_ABSOLUTE'
  | 'PATH_ESCAPE'
  | 'DUPLICATE_PATH'
  | 'FILE_EXISTS'
  | 'SIZE_EXCEEDED'
  | 'TOTAL_SIZE_EXCEEDED'
  | 'TOO_MANY_FILES'
  | 'INVALID_MODE'
  | 'INVALID_DIFF'
  | 'INVALID_ENCODING'
  | 'INVALID_NEWLINE'
  | 'UNKNOWN_ATTR'
  | 'DUPLICATE_ATTR'
  | 'ENCODING_INVALID'
  | 'MATERIALIZE_FAILED'

/** One actionable validation or materialization failure. */
export interface B2FError {
  readonly code: B2FErrorCode
  /** Target path as written by the model, when one exists. */
  readonly path: string | null
  readonly hint: string
}

/** Materialization status for one file block. */
export type MaterializeStatus = 'created' | 'updated' | 'appended' | 'unchanged'

/** Outcome for one successfully written file block. */
export interface MaterializeResult {
  readonly path: string
  readonly mode: FileBlockMode
  readonly status: MaterializeStatus
  readonly lines: number
  readonly added: number
  readonly removed: number
  readonly diffText: string | null
}

/** Full outcome of one assistant message's b2f pipeline run. */
export interface B2FReport {
  readonly ok: boolean
  readonly results: readonly MaterializeResult[]
  readonly errors: readonly B2FError[]
  /** Optional `git status --short` snapshot for feedback. */
  readonly gitStatus: string | null
}

/** Per-step pipeline state retained between session/event and tools/pre-execute. */
export interface StepB2FState {
  readonly turn: number
  readonly step: number
  readonly report: B2FReport
  readonly feedback: string
}

/** Hints injected into validation failures. */
export const ERROR_HINTS: Record<B2FErrorCode, string> = {
  PATH_REQUIRED: 'add file=<relative-path> to the fenced code block info string',
  PATH_ABSOLUTE: 'use a path relative to $DSH_B2F_ROOT, e.g. file=src/app.py',
  PATH_ESCAPE: 'use a relative path inside $DSH_B2F_ROOT; `.` and `..` path segments are rejected',
  DUPLICATE_PATH: 'merge every block targeting this path into one file block in this message',
  FILE_EXISTS: 'use mode=write to overwrite the existing file, or choose a different path',
  SIZE_EXCEEDED: 'split the file into smaller files or reduce its content',
  TOTAL_SIZE_EXCEEDED: 'split the content across multiple assistant messages',
  TOO_MANY_FILES: 'split the file blocks across multiple assistant messages',
  INVALID_MODE: 'use one of mode=write, mode=create, or mode=append',
  INVALID_DIFF: 'use one of diff=full, diff=limited, diff=stats, or diff=none',
  INVALID_ENCODING: 'omit the encoding attribute (only utf-8 is supported)',
  INVALID_NEWLINE: 'use one of newline=preserve, newline=lf, or newline=crlf',
  UNKNOWN_ATTR: 'check the attribute spelling; known attributes are file, mode, diff, encoding, newline',
  DUPLICATE_ATTR: 'specify each attribute once per fenced code block',
  ENCODING_INVALID: 'emit UTF-8 text only',
  MATERIALIZE_FAILED: 'retry the write, or check available disk space and permissions',
}
