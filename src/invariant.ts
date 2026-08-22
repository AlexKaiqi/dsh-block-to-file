/**
 * Package-owned invariant companion for `dsh-block-to-file`.
 * @module dsh-block-to-file/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-block-to-file'

/** Cordis companion plugin name. */
export const name = 'block-to-file-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime check: b2f's linear Git ref and CAS publication are covered by
// transaction integration tests. The empty installer still reserves ownership.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
