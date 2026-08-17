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

/** Git blob identity observed by an agent; `absent` is versioned non-existence. */
export type FileVersion = string | 'absent'

/** One explicit observation supplied by a read-capable runtime plugin. */
export interface FileObservation {
  readonly path: string
  readonly fileVersion: FileVersion
  readonly repoRevision: string
}

/** Stable machine-routing error codes, one entry per failed block. */
export type B2FErrorCode =
  | 'PATH_REQUIRED'
  | 'PATH_ABSOLUTE'
  | 'PATH_ESCAPE'
  | 'DUPLICATE_PATH'
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

/** Commit metadata explaining one canonical change since an observation. */
export interface ChangeSinceRead {
  readonly commit: string
  readonly agent: string | null
  readonly message: string
}

/** Latest canonical state returned for one stale transaction path. */
export interface StaleFile {
  readonly path: string
  readonly content: string | null
  readonly fileVersion: FileVersion
  readonly observedVersion: FileVersion
  readonly repoRevision: string
  readonly changesSinceRead: readonly ChangeSinceRead[]
}

/** A whole assistant message was committed as one Git transaction. */
export interface B2FCommittedReport {
  readonly status: 'committed'
  readonly ok: true
  readonly commit: string
  readonly repoRevision: string
  readonly results: readonly MaterializeResult[]
  readonly errors: readonly []
  readonly staleFiles: readonly []
}

/** No proposal was committed because at least one target path was stale. */
export interface B2FStaleReport {
  readonly status: 'stale'
  readonly ok: false
  readonly commit: null
  readonly repoRevision: string
  readonly results: readonly []
  readonly errors: readonly []
  readonly staleFiles: readonly StaleFile[]
}

/** Parsing, validation, or pre-publication repository failure. */
export interface B2FFailedReport {
  readonly status: 'failed'
  readonly ok: false
  readonly commit: null
  readonly repoRevision: string | null
  readonly results: readonly []
  readonly errors: readonly B2FError[]
  readonly staleFiles: readonly []
}

/** Canonical publication succeeded but the local worktree could not catch up. */
export interface B2FProjectionFailedReport {
  readonly status: 'projection-failed'
  readonly ok: false
  readonly commit: string
  readonly repoRevision: string
  readonly results: readonly MaterializeResult[]
  readonly errors: readonly B2FError[]
  readonly staleFiles: readonly []
}

/** Full transactional outcome of one assistant message's b2f pipeline run. */
export type B2FReport = B2FCommittedReport | B2FStaleReport | B2FFailedReport | B2FProjectionFailedReport

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
