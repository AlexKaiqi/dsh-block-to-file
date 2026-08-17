/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-block-to-file`.
 * @module @deepseek-ai/dsh-block-to-file/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-block-to-file'

/** Cordis companion plugin name. */
export const name = 'block-to-file-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No session-log invariant: b2f's durable state is a linear canonical Git ref
 * whose parent relation and compare-and-swap publication are enforced by the
 * plugin's transaction implementation.
 * @param _ctx - registrant context (unused; kept for the Cordis plugin face).
 * @returns an empty installer reservation for package ownership.
 */
export function apply(_ctx: Context): InvariantInstaller | undefined {
  void PACKAGE_NAME
  return undefined
}
