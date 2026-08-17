/**
 * Atomic file materializer for validated b2f blocks.
 *
 * Materialization is the only phase that touches the filesystem. Writes are
 * staged in `<root>/.b2f/tmp` and renamed over the target, so a crash never
 * leaves a half-written file.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { countDiffStats, unifiedDiff } from './diff.ts'
import type { B2FError, FileBlockDiff, FileBlockNewline, MaterializeResult } from './types.ts'
import type { ValidatedFileBlock } from './validator.ts'

/** Materializer configuration. */
export interface MaterializeConfig {
  readonly root: string
  readonly diffLineLimit: number
  readonly tempFileKeep: number
}

/** Accumulated materialization outcome for all blocks in one message. */
export interface MaterializeOutcome {
  readonly results: readonly MaterializeResult[]
  readonly errors: readonly B2FError[]
}

/**
 * Materialize all validated blocks in message order.
 * A failed block records `MATERIALIZE_FAILED` and stops later writes; earlier
 * writes remain on disk and are reported as written.
 */
export function materializeAll(
  validated: readonly ValidatedFileBlock[],
  config: MaterializeConfig,
): MaterializeOutcome {
  const results: MaterializeResult[] = []
  const errors: B2FError[] = []

  for (const entry of validated) {
    try {
      results.push(materializeOne(entry, config))
    } catch (error: unknown) {
      errors.push({
        code: 'MATERIALIZE_FAILED',
        path: entry.block.path,
        hint: error instanceof Error ? error.message : String(error),
      })
      break
    }
  }

  return { results, errors }
}

function materializeOne(entry: ValidatedFileBlock, config: MaterializeConfig): MaterializeResult {
  const { block, normalizedPath, targetPath } = entry
  const previous = readPrevious(targetPath)
  const content = convertNewlines(block.content, block.newline as FileBlockNewline)

  switch (block.mode) {
    case 'create': {
      atomicWrite(targetPath, config.root, Buffer.from(content, 'utf8'), config.tempFileKeep)
      const lines = countLines(content)
      return {
        path: normalizedPath,
        mode: block.mode,
        status: 'created',
        lines,
        added: lines,
        removed: 0,
        diffText: null,
      }
    }
    case 'append': {
      if (previous !== undefined && previous.endsWith(content)) {
        return {
          path: normalizedPath,
          mode: block.mode,
          status: 'unchanged',
          lines: countLines(previous),
          added: 0,
          removed: 0,
          diffText: null,
        }
      }
      const merged = previous === undefined ? content : previous + content
      atomicWrite(targetPath, config.root, Buffer.from(merged, 'utf8'), config.tempFileKeep)
      return {
        path: normalizedPath,
        mode: block.mode,
        status: 'appended',
        lines: countLines(merged),
        added: countLines(content),
        removed: 0,
        diffText: null,
      }
    }
    case 'write': {
      atomicWrite(targetPath, config.root, Buffer.from(content, 'utf8'), config.tempFileKeep)
      const oldText = previous ?? ''
      const diffText = renderDiff(oldText, content, normalizedPath, block.diff as FileBlockDiff, config.diffLineLimit)
      const diffLines = diffText === null ? [] : diffText.split('\n')
      const { added, removed } = countDiffStats(diffLines)
      return {
        path: normalizedPath,
        mode: block.mode,
        status: previous === undefined ? 'created' : 'updated',
        lines: countLines(content),
        added,
        removed,
        diffText,
      }
    }
    default:
      throw new Error(`unreachable mode after validation: ${JSON.stringify(block.mode)}`)
  }
}

/** Read previous file content, or undefined when the target does not exist. */
function readPrevious(targetPath: string): string | undefined {
  if (!existsSync(targetPath)) return undefined
  return readFileSync(targetPath, 'utf8')
}

/** Convert line endings according to the block's `newline` attribute. */
function convertNewlines(content: string, newline: FileBlockNewline): string {
  if (newline === 'lf') return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (newline === 'crlf') return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
  return content
}

/** Count model-facing lines: newline count plus one for a non-empty unterminated final line. */
function countLines(content: string): number {
  if (content.length === 0) return 0
  const newlines = content.match(/\n/g)?.length ?? 0
  return content.endsWith('\n') ? newlines : newlines + 1
}

/** Write bytes atomically: temp file + fsync + rename over the target. */
function atomicWrite(targetPath: string, root: string, buffer: Buffer, tempFileKeep: number): void {
  assertPathInsideRoot(dirname(targetPath), root)
  const tmpDir = resolveTempDir(root)
  assertTempDirOutsideRoot(tmpDir, root)
  mkdirSync(dirname(targetPath), { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `b2f-${process.pid}-${randomUUID()}`)
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, buffer)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmpPath, targetPath)
    fsyncDir(dirname(targetPath))
    fsyncDir(tmpDir)
  } finally {
    sweepTempDir(tmpDir, tempFileKeep)
  }
  try {
    // Cleanup after a failed rename without masking the original IO error.
    rmSync(tmpPath, { force: true })
  } catch {
    // The rename may have succeeded; nothing to clean.
  }
}

/** Best-effort directory fsync; not every platform supports syncing directories. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // File data was already fsynced; directory fsync is a durability bonus.
  }
}

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

/** Reject paths whose existing ancestors are symlinks escaping `root`. */
function assertPathInsideRoot(targetPath: string, root: string): void {
  if (!isAbsolute(root)) throw new Error(`block-to-file: root must be absolute (got ${root})`)
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  const segments = relative(root, targetPath).split(sep).filter(segment => segment.length > 0)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    if (!existsSync(current)) return // remaining ancestors do not exist yet; mkdir creates real directories
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`block-to-file: symlink escape blocked at ${current}`)
    }
    const realCurrent = realpathSync(current)
    if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + sep)) {
      throw new Error(`block-to-file: symlink escape blocked at ${current} (resolves to ${realCurrent})`)
    }
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

/** Render a diff for `write` mode according to the block's `diff` strategy. */
function renderDiff(
  oldText: string,
  newText: string,
  path: string,
  strategy: FileBlockDiff,
  diffLineLimit: number,
): string | null {
  if (strategy === 'none') return null
  const full = unifiedDiff(oldText, newText, `a/${path}`, `b/${path}`)
  if (full === null) return null
  if (strategy === 'stats') return null
  if (strategy === 'full') return full
  // limited: keep the first `diffLineLimit` diff lines, then summarize.
  const lines = full.split('\n')
  if (lines.length <= diffLineLimit) return full
  const head = lines.slice(0, diffLineLimit).join('\n')
  const { added, removed } = countDiffStats(lines)
  return `${head}\n[b2f] diff truncated to ${diffLineLimit} lines (+${added}/-${removed})`
}
