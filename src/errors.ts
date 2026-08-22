/**
 * Stable error contract for the b2f pipeline.
 *
 * b2f errors are DATA, not exceptions: a failed block becomes a {@link B2FError}
 * carried in the transaction report and rendered into `[b2f]` feedback, because
 * the model — not a `catch` block — is the consumer that has to act on it. The
 * class below exists for the boundary where b2f must throw into host code
 * (deployment misconfiguration, repository failure) while keeping the same
 * `code` / `path` / `hint` fields the model-facing values carry.
 *
 * Every error carries an executable next step in `hint`, sourced from
 * `ERROR_HINTS`, so a refusal always names what to do instead.
 *
 * @module dsh-block-to-file
 */

import { ERROR_HINTS, type B2FError, type B2FErrorCode } from './types.ts'

/**
 * Stable error class for failures b2f raises rather than reports.
 *
 * Carries the same fields as a reported {@link B2FError} so a thrown failure and
 * a reported one can be handled uniformly.
 */
export class BlockToFileError extends Error {
  /** Machine-routable failure code, shared with reported errors. */
  readonly code: B2FErrorCode
  /** Target path when the failure belongs to one block, else null. */
  readonly path: string | null
  /** Executable next step; never just a restatement of the failure. */
  readonly hint: string

  constructor(code: B2FErrorCode, path: string | null, detail?: string) {
    const hint = ERROR_HINTS[code]
    super(detail === undefined ? hint : `${detail} ${hint}`)
    this.name = 'BlockToFileError'
    this.code = code
    this.path = path
    this.hint = hint
  }

  /** Project this failure into the reported error shape. */
  toB2FError(): B2FError {
    return { code: this.code, path: this.path, hint: this.message }
  }
}

/**
 * Build a reported error, always attaching the code's executable next step.
 * @param code - machine-routable failure code.
 * @param path - target path as written by the model, or null.
 * @param detail - specific context prepended to the standing hint.
 */
export function b2fError(code: B2FErrorCode, path: string | null, detail?: string): B2FError {
  const hint = ERROR_HINTS[code]
  return { code, path, hint: detail === undefined ? hint : `${detail} ${hint}` }
}

/** True when `value` is a b2f error value carrying the full contract. */
export function isB2FError(value: unknown): value is B2FError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<B2FError>
  return typeof candidate.code === 'string'
    && typeof candidate.hint === 'string'
    && (candidate.path === null || typeof candidate.path === 'string')
}
