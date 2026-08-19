/**
 * Shared vocabulary for the block-to-file (b2f) runtime pipeline.
 * @module @deepseek-ai/dsh-block-to-file
 */

/** Valid block materialization modes. */
export type FileBlockMode = 'write' | 'create' | 'update' | 'append' | 'delete' | 'edit' | 'diff'

/**
 * Which partial-edit dialect is exposed to the model.
 *
 * Exactly one is active per deployment so the model never has to choose a patch
 * format; the inactive edit mode is rejected with a corrective error.
 * - `replace`: `mode=edit`, SEARCH/REPLACE blocks anchored on content.
 * - `git_diff`: `mode=diff`, hunk-only unified diff anchored on line + context.
 * - `none`: no partial edits; full-content blocks only.
 */
export type EditFormat = 'replace' | 'git_diff' | 'none'

/** The block mode each edit dialect accepts. */
export const EDIT_MODE_FOR_FORMAT = {
  replace: 'edit',
  git_diff: 'diff',
} as const satisfies Record<Exclude<EditFormat, 'none'>, FileBlockMode>

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
  /**
   * True when the block itself carried `newline=`, as opposed to inheriting the
   * deployment default. Edit modes reject an explicit value but must tolerate
   * the inherited one.
   */
  readonly newlineExplicit: boolean
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
  | 'DELETE_CONTENT'
  | 'FILE_EXISTS'
  | 'FILE_NOT_FOUND'
  | 'EDIT_MODE_DISABLED'
  | 'EDIT_EMPTY'
  | 'EDIT_NEWLINE_ATTR'
  | 'EDIT_MALFORMED'
  | 'EDIT_SEARCH_NOT_FOUND'
  | 'EDIT_SEARCH_AMBIGUOUS'
  | 'EDIT_SPAN_OVERLAP'
  | 'EDIT_CONTEXT_MISMATCH'
  | 'MATERIALIZE_FAILED'

/** One actionable validation, precondition, or materialization failure. */
export interface B2FError {
  readonly code: B2FErrorCode
  /** Target path as written by the model, when one exists. */
  readonly path: string | null
  readonly hint: string
}

/** Materialization status for one file block. */
export type MaterializeStatus = 'created' | 'updated' | 'appended' | 'deleted' | 'unchanged'

/** Outcome for one successfully evaluated file block. */
export interface MaterializeResult {
  readonly path: string
  readonly mode: FileBlockMode
  readonly status: MaterializeStatus
  readonly lines: number
  readonly added: number
  readonly removed: number
  readonly diffText: string | null
  /** Dialect that resolved this block, or null for a full-content block. */
  readonly editFormat: Exclude<EditFormat, 'none'> | null
  /** Edits the block proposed; 0 for a full-content block. */
  readonly editsProposed: number
  /** Edits successfully applied; equals `editsProposed` on success. */
  readonly editsApplied: number
  /**
   * Largest line drift between a hunk's stated and matched anchor. Always 0 for
   * `replace` (content anchors do not drift) and for full-content blocks; the
   * direct measure of how much line movement `git_diff` absorbed.
   */
  readonly fuzz: number
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

/** Canonical state returned when an operation's existence precondition fails. */
export interface PreconditionFile {
  readonly path: string
  readonly content: string | null
  readonly fileVersion: FileVersion
}

/** A worktree path that differs from both the projected source and target. */
export interface DirtyFile {
  readonly path: string
  readonly content: string | null
  readonly fileVersion: FileVersion | 'non-file'
  readonly expectedVersion: FileVersion
  readonly targetVersion: FileVersion
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

/** Every proposal was already satisfied, so no commit was created. */
export interface B2FUnchangedReport {
  readonly status: 'unchanged'
  readonly ok: true
  readonly commit: null
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

/** No proposal was committed because a mode existence condition was not met. */
export interface B2FPreconditionFailedReport {
  readonly status: 'precondition-failed'
  readonly ok: false
  readonly commit: null
  readonly repoRevision: string
  readonly results: readonly []
  readonly errors: readonly B2FError[]
  readonly staleFiles: readonly []
  readonly files: readonly PreconditionFile[]
}

/** No proposal was committed because projection would overwrite local drift. */
export interface B2FWorktreeDirtyReport {
  readonly status: 'worktree-dirty'
  readonly ok: false
  readonly commit: null
  readonly repoRevision: string
  readonly results: readonly []
  readonly errors: readonly []
  readonly staleFiles: readonly []
  readonly dirtyFiles: readonly DirtyFile[]
}

/**
 * No proposal was committed because an edit block's anchors did not resolve.
 *
 * Reported only after the staleness check passes, so the echoed content IS the
 * current canonical content and the failure is unambiguously the model's to fix.
 */
export interface B2FEditUnresolvedReport {
  readonly status: 'edit-unresolved'
  readonly ok: false
  readonly commit: null
  readonly repoRevision: string
  readonly results: readonly []
  readonly errors: readonly B2FError[]
  readonly staleFiles: readonly []
  /** Current content of each path whose edit failed, for an immediate retry. */
  readonly files: readonly PreconditionFile[]
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
export type B2FReport =
  | B2FCommittedReport
  | B2FUnchangedReport
  | B2FStaleReport
  | B2FPreconditionFailedReport
  | B2FWorktreeDirtyReport
  | B2FEditUnresolvedReport
  | B2FFailedReport
  | B2FProjectionFailedReport

/** Per-step pipeline state retained between session/event and tools/pre-execute. */
export interface StepB2FState {
  readonly turn: number
  readonly step: number
  readonly report: B2FReport
  readonly feedback: string
}

/** Hints injected into validation and precondition failures. */
export const ERROR_HINTS: Record<B2FErrorCode, string> = {
  PATH_REQUIRED: 'add file=<relative-path> to the fenced code block info string',
  PATH_ABSOLUTE: 'use a path relative to $DSH_B2F_ROOT, e.g. file=src/app.py',
  PATH_ESCAPE: 'use a relative path inside $DSH_B2F_ROOT; `.` and `..` path segments are rejected',
  DUPLICATE_PATH: 'merge every block targeting this path into one file block in this message',
  SIZE_EXCEEDED: 'split the file into smaller files or reduce its content',
  TOTAL_SIZE_EXCEEDED: 'split the content across multiple assistant messages',
  TOO_MANY_FILES: 'split the file blocks across multiple assistant messages',
  INVALID_MODE: 'use one of mode=write, mode=create, mode=update, mode=append, mode=delete, or the edit mode named in the b2f instructions',
  INVALID_DIFF: 'use one of diff=full, diff=limited, diff=stats, or diff=none',
  INVALID_ENCODING: 'omit the encoding attribute (only utf-8 is supported)',
  INVALID_NEWLINE: 'use one of newline=preserve, newline=lf, or newline=crlf',
  UNKNOWN_ATTR: 'check the attribute spelling; known attributes are file, mode, diff, encoding, newline',
  DUPLICATE_ATTR: 'specify each attribute once per fenced code block',
  ENCODING_INVALID: 'emit UTF-8 text only',
  DELETE_CONTENT: 'mode=delete requires an empty fenced block',
  FILE_EXISTS: 'mode=create requires the target to be absent; use mode=update or mode=write after reviewing it',
  FILE_NOT_FOUND: 'mode=update requires an existing file; use mode=create or mode=write after checking the path',
  EDIT_MODE_DISABLED: 'this deployment exposes a different edit format; see the b2f instructions for the mode to use',
  EDIT_EMPTY: 'an edit block must contain at least one edit',
  EDIT_NEWLINE_ATTR: 'omit newline= on an edit block; edits preserve the file\'s existing line endings',
  EDIT_MALFORMED: 'fix the edit block syntax and re-emit it',
  EDIT_SEARCH_NOT_FOUND: 'copy the text to change verbatim from the file, including indentation',
  EDIT_SEARCH_AMBIGUOUS: 'extend the SEARCH block with surrounding lines until it identifies one location',
  EDIT_SPAN_OVERLAP: 'merge the overlapping edits into one, or target distinct regions',
  EDIT_CONTEXT_MISMATCH: 'recheck the line numbers and context lines against the file content shown below',
  MATERIALIZE_FAILED: 'retry the operation, or check repository state, disk space, and permissions',
}
