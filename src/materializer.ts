/**
 * Temp-directory helpers for b2f's atomic filesystem staging.
 *
 * Writes are staged outside the repository root and renamed over the target, so
 * a crash never leaves a half-written file and the working tree never carries
 * b2f scratch state. The staging directory itself is resolved and policed here;
 * `transaction.ts` owns the writes that use it.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Resolve the atomic-write temp directory for a root; never inside the root. */
export function resolveTempDir(root: string): string {
  const env = process.env.DSH_B2F_TMP
  if (env !== undefined && env.trim().length > 0) return resolve(env)
  const normalized = root.replace(/[/\\]+$/, '') || root
  return `${normalized}.b2f-tmp`
}

/** Reject a temp dir that would pollute the working tree (root or a descendant). */
export function assertTempDirOutsideRoot(tmpDir: string, root: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTmp = resolve(tmpDir)
  if (resolvedTmp === resolvedRoot || resolvedTmp.startsWith(resolvedRoot + sep)) {
    throw new Error(`block-to-file: temp dir ${tmpDir} must be outside $DSH_B2F_ROOT to keep the working tree clean`)
  }
}

/** Drop old temp-file residue from crashed writes, keeping the newest `keep` files. */
export function sweepTempDir(tmpDir: string, keep: number): void {
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return
  }
  const files = entries
    .map(name => join(tmpDir, name))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      rmSync(file, { force: true })
    } catch {
      // Best-effort GC; a racing write keeps its file.
    }
  }
}
