import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { countDiffStats, unifiedDiff } from './diff.ts'
import { resolveTempDir, sweepTempDir } from './materializer.ts'
import { ERROR_HINTS } from './types.ts'
import type { ValidatedFileBlock } from './validator.ts'
import type {
  B2FError,
  B2FReport,
  ChangeSinceRead,
  DirtyFile,
  FileBlockDiff,
  FileBlockMode,
  FileBlockNewline,
  FileObservation,
  FileVersion,
  MaterializeResult,
  PreconditionFile,
  StaleFile,
} from './types.ts'

/** One validated proposal paired with the version on which it is based. */
export interface ObservedFileProposal {
  readonly entry: ValidatedFileBlock
  readonly observation: FileObservation
}

/** Git transaction configuration. */
export interface TransactionConfig {
  readonly root: string
  readonly canonicalRef: string
  readonly agentId: string
  /** Revision currently projected in this agent's worktree. */
  readonly viewRevision: string
  readonly diffLineLimit: number
  readonly tempFileKeep: number
  readonly maxCasRetries: number
}

interface Candidate {
  readonly path: string
  readonly mode: FileBlockMode
  readonly expectedVersion: FileVersion
  readonly observedRevision: string
  readonly content: string | null
  readonly preconditionError: B2FError | null
  readonly result: MaterializeResult
}

interface TreeEntry {
  readonly mode: string
  readonly version: FileVersion
}

interface WorktreeEntry {
  readonly version: FileVersion | 'non-file'
  readonly content: string | null
}

/** Resolve the current canonical commit, initializing the ref from HEAD once. */
export function resolveCanonicalRevision(root: string, canonicalRef: string): string {
  assertGitRoot(root)
  const current = tryGit(root, ['rev-parse', '--verify', canonicalRef])
  if (current !== null) return current.trim()
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim()
  tryGit(root, ['update-ref', canonicalRef, head, '0000000000000000000000000000000000000000'])
  return git(root, ['rev-parse', '--verify', canonicalRef]).trim()
}

/** Resolve the worktree's Git HEAD, used as the initial projection baseline. */
export function resolveWorktreeRevision(root: string): string {
  assertGitRoot(root)
  return git(root, ['rev-parse', '--verify', 'HEAD']).trim()
}

/** Return the blob identity for a path at one repository revision. */
export function fileVersionAt(root: string, revision: string, path: string): FileVersion {
  return treeEntryAt(root, revision, path).version
}

/** Compare every observed path and publish all proposed contents in one commit. */
export function commitFileBlocks(
  proposals: readonly ObservedFileProposal[],
  config: TransactionConfig,
): B2FReport {
  try {
    const candidates = proposals.map(proposal => buildCandidate(proposal, config))

    for (let attempt = 0; attempt < config.maxCasRetries; attempt++) {
      const head = resolveCanonicalRevision(config.root, config.canonicalRef)
      const staleFiles = findStaleFiles(candidates, head, config.root)
      if (staleFiles.length > 0) {
        const dirtyFiles = findWorktreeDirty(
          config.root,
          config.viewRevision,
          head,
          candidates.map(candidate => candidate.path),
        )
        if (dirtyFiles.length > 0) return worktreeDirtyReport(head, dirtyFiles)
        projectRevision(config.root, config.viewRevision, head, config.tempFileKeep)
        return {
          status: 'stale',
          ok: false,
          commit: null,
          repoRevision: head,
          results: [],
          errors: [],
          staleFiles,
        }
      }

      const preconditionErrors = candidates
        .map(candidate => candidate.preconditionError)
        .filter((error): error is B2FError => error !== null)
      if (preconditionErrors.length > 0) {
        const files: PreconditionFile[] = preconditionErrors.map(error => {
          const path = error.path!
          const version = fileVersionAt(config.root, head, path)
          return {
            path,
            content: version === 'absent' ? null : readBlob(config.root, version),
            fileVersion: version,
          }
        })
        return {
          status: 'precondition-failed',
          ok: false,
          commit: null,
          repoRevision: head,
          results: [],
          errors: preconditionErrors,
          staleFiles: [],
          files,
        }
      }

      const tree = buildTree(config.root, head, candidates)
      const dirtyFiles = findWorktreeDirty(
        config.root,
        config.viewRevision,
        tree,
        candidates.map(candidate => candidate.path),
      )
      if (dirtyFiles.length > 0) return worktreeDirtyReport(head, dirtyFiles)

      if (tree === treeForRevision(config.root, head)) {
        try {
          projectRevision(config.root, config.viewRevision, head, config.tempFileKeep)
        } catch (error: unknown) {
          return projectionFailedReport(head, candidates, error)
        }
        return {
          status: 'unchanged',
          ok: true,
          commit: null,
          repoRevision: head,
          results: candidates.map(candidate => candidate.result),
          errors: [],
          staleFiles: [],
        }
      }

      const changedPaths = candidates
        .filter(candidate => candidate.result.status !== 'unchanged')
        .map(candidate => candidate.path)
      const commit = createCommit(config.root, tree, head, config.agentId, changedPaths)
      if (!updateRef(config.root, config.canonicalRef, commit, head)) continue

      try {
        projectRevision(config.root, config.viewRevision, commit, config.tempFileKeep)
      } catch (error: unknown) {
        return projectionFailedReport(commit, candidates, error)
      }
      return {
        status: 'committed',
        ok: true,
        commit,
        repoRevision: commit,
        results: candidates.map(candidate => candidate.result),
        errors: [],
        staleFiles: [],
      }
    }
    throw new Error(`canonical ref CAS did not settle after ${config.maxCasRetries} attempts`)
  } catch (error: unknown) {
    return {
      status: 'failed',
      ok: false,
      commit: null,
      repoRevision: null,
      results: [],
      errors: [{
        code: 'MATERIALIZE_FAILED',
        path: null,
        hint: error instanceof Error ? error.message : String(error),
      }],
      staleFiles: [],
    }
  }
}

function projectionFailedReport(
  revision: string,
  candidates: readonly Candidate[],
  error: unknown,
): B2FReport {
  return {
    status: 'projection-failed',
    ok: false,
    commit: revision,
    repoRevision: revision,
    results: candidates.map(candidate => candidate.result),
    errors: [{
      code: 'MATERIALIZE_FAILED',
      path: null,
      hint: error instanceof Error ? error.message : String(error),
    }],
    staleFiles: [],
  }
}

function worktreeDirtyReport(repoRevision: string, dirtyFiles: readonly DirtyFile[]): B2FReport {
  return {
    status: 'worktree-dirty',
    ok: false,
    commit: null,
    repoRevision,
    results: [],
    errors: [],
    staleFiles: [],
    dirtyFiles,
  }
}

function buildCandidate(proposal: ObservedFileProposal, config: TransactionConfig): Candidate {
  const { block, normalizedPath } = proposal.entry
  const mode = block.mode as FileBlockMode
  const expectedVersion = proposal.observation.fileVersion
  const previous = readObservedContent(config.root, expectedVersion)
  const proposed = convertNewlines(block.content, block.newline as FileBlockNewline)

  let content: string | null
  let status: MaterializeResult['status']
  let added = 0
  let removed = 0
  let rawDiff: string | null = null

  switch (mode) {
    case 'write':
    case 'create':
    case 'update': {
      content = proposed
      status = expectedVersion === 'absent'
        ? 'created'
        : previous === proposed ? 'unchanged' : 'updated'
      rawDiff = mode === 'create' ? null : unifiedDiff(previous, content, `a/${normalizedPath}`, `b/${normalizedPath}`)
      const stats = rawDiff === null ? { added: 0, removed: 0 } : countDiffStats(rawDiff.split('\n'))
      added = expectedVersion === 'absent' ? countLines(content) : stats.added
      removed = stats.removed
      break
    }
    case 'append': {
      if (expectedVersion === 'absent') {
        content = proposed
        status = 'created'
        added = countLines(proposed)
      } else if (previous.endsWith(proposed)) {
        content = previous
        status = 'unchanged'
      } else {
        content = previous + proposed
        status = 'appended'
        added = countLines(proposed)
      }
      break
    }
    case 'delete': {
      content = null
      if (expectedVersion === 'absent') {
        status = 'unchanged'
      } else {
        status = 'deleted'
        removed = countLines(previous)
        rawDiff = unifiedDiff(previous, '', `a/${normalizedPath}`, `b/${normalizedPath}`)
      }
      break
    }
  }

  const preconditionError = mode === 'create' && expectedVersion !== 'absent'
    ? { code: 'FILE_EXISTS' as const, path: normalizedPath, hint: ERROR_HINTS.FILE_EXISTS }
    : mode === 'update' && expectedVersion === 'absent'
      ? { code: 'FILE_NOT_FOUND' as const, path: normalizedPath, hint: ERROR_HINTS.FILE_NOT_FOUND }
      : null

  return {
    path: normalizedPath,
    mode,
    expectedVersion,
    observedRevision: proposal.observation.repoRevision,
    content,
    preconditionError,
    result: {
      path: normalizedPath,
      mode,
      status,
      lines: content === null ? 0 : countLines(content),
      added,
      removed,
      diffText: selectDiff(rawDiff, block.diff as FileBlockDiff, config.diffLineLimit),
    },
  }
}

function findStaleFiles(candidates: readonly Candidate[], head: string, root: string): StaleFile[] {
  const stale: StaleFile[] = []
  for (const candidate of candidates) {
    const current = fileVersionAt(root, head, candidate.path)
    if (current === candidate.expectedVersion) continue
    stale.push({
      path: candidate.path,
      content: current === 'absent' ? null : readBlob(root, current),
      fileVersion: current,
      observedVersion: candidate.expectedVersion,
      repoRevision: head,
      changesSinceRead: changesSince(root, candidate.observedRevision, head, candidate.path),
    })
  }
  return stale
}

function buildTree(root: string, head: string, candidates: readonly Candidate[]): string {
  const indexPath = join(resolveTempDir(root), `index-${process.pid}-${randomUUID()}`)
  mkdirSync(dirname(indexPath), { recursive: true })
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  try {
    git(root, ['read-tree', head], undefined, env)
    for (const candidate of candidates) {
      if (candidate.content === null) {
        git(root, ['update-index', '--force-remove', '--', candidate.path], undefined, env)
        continue
      }
      const oid = git(root, ['hash-object', '-w', '--stdin'], candidate.content).trim()
      const currentEntry = treeEntryAt(root, head, candidate.path)
      const mode = currentEntry.mode === '100755' ? '100755' : '100644'
      git(root, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${candidate.path}`], undefined, env)
    }
    return git(root, ['write-tree'], undefined, env).trim()
  } finally {
    rmSync(indexPath, { force: true })
  }
}

function findWorktreeDirty(
  root: string,
  fromRevision: string,
  targetTreeish: string,
  extraPaths: readonly string[],
): DirtyFile[] {
  const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', fromRevision, targetTreeish])
    .split('\0')
    .filter(path => path.length > 0)
  const paths = [...new Set([...changed, ...extraPaths])]
  const dirty: DirtyFile[] = []

  for (const path of paths) {
    const expectedVersion = fileVersionAt(root, fromRevision, path)
    const targetVersion = fileVersionAt(root, targetTreeish, path)
    const worktree = readWorktreeEntry(root, path)
    if (worktree.version === expectedVersion || worktree.version === targetVersion) continue
    dirty.push({
      path,
      content: worktree.content,
      fileVersion: worktree.version,
      expectedVersion,
      targetVersion,
    })
  }
  return dirty
}

function readWorktreeEntry(root: string, path: string): WorktreeEntry {
  const target = join(root, path)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 'absent', content: null }
    throw error
  }

  if (stat.isSymbolicLink()) {
    const content = readlinkSync(target)
    return {
      version: hashBuffer(root, Buffer.from(content)),
      content,
    }
  }
  if (!stat.isFile()) return { version: 'non-file', content: null }

  const buffer = readFileSync(target)
  return {
    version: hashBuffer(root, buffer),
    content: buffer.toString('utf8'),
  }
}

function hashBuffer(root: string, buffer: Buffer): string {
  return execFileSync('git', ['hash-object', '--stdin'], {
    cwd: root,
    encoding: 'utf8',
    input: buffer,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function createCommit(root: string, tree: string, parent: string, agentId: string, paths: readonly string[]): string {
  const message = `b2f: update ${paths.length} file(s)\n\nB2F-Agent: ${agentId}\n`
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'block-to-file',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'b2f@localhost',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'block-to-file',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'b2f@localhost',
  }
  return git(root, ['commit-tree', tree, '-p', parent], message, env).trim()
}

function updateRef(root: string, ref: string, commit: string, expected: string): boolean {
  return tryGit(root, ['update-ref', ref, commit, expected]) !== null
}

function changesSince(root: string, observedRevision: string, head: string, path: string): ChangeSinceRead[] {
  if (observedRevision === head) return []
  const output = tryGit(root, [
    'log',
    '--format=%H%x1f%s%x1f%(trailers:key=B2F-Agent,valueonly)%x1e',
    `${observedRevision}..${head}`,
    '--',
    path,
  ])
  if (output === null) return []
  return output.split('\x1e').map(record => record.trim()).filter(Boolean).map((record) => {
    const [commit = '', message = '', agent = ''] = record.split('\x1f')
    return { commit, message, agent: agent.trim().length === 0 ? null : agent.trim() }
  })
}

function treeEntryAt(root: string, revision: string, path: string): TreeEntry {
  const output = git(root, ['ls-tree', revision, '--', path]).trim()
  if (output.length === 0) return { mode: '100644', version: 'absent' }
  const match = /^(\d+)\s+blob\s+([0-9a-f]+)\t/.exec(output)
  if (match === null) throw new Error(`path is not a regular Git blob: ${path}`)
  return { mode: match[1]!, version: match[2]! }
}

function treeForRevision(root: string, revision: string): string {
  return git(root, ['rev-parse', `${revision}^{tree}`]).trim()
}

function readObservedContent(root: string, version: FileVersion): string {
  return version === 'absent' ? '' : readBlob(root, version)
}

function readBlob(root: string, oid: string): string {
  return git(root, ['cat-file', 'blob', oid])
}

function readBlobBuffer(root: string, oid: string): Buffer {
  return execFileSync('git', ['cat-file', 'blob', oid], {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Project the complete canonical delta so the agent worktree matches its new revision. */
export function projectRevision(root: string, fromRevision: string, toRevision: string, tempFileKeep: number): void {
  if (fromRevision === toRevision) return
  const output = git(root, ['diff', '--name-only', '--no-renames', '-z', fromRevision, toRevision])
  const paths = output.split('\0').filter(path => path.length > 0)
  const tmpDir = resolveTempDir(root)
  mkdirSync(tmpDir, { recursive: true })
  const staged = paths.map((path) => {
    const targetPath = join(root, path)
    assertPathInsideRoot(dirname(targetPath), root)
    const entry = treeEntryAt(root, toRevision, path)
    if (entry.version === 'absent') return { targetPath, tmpPath: null }
    mkdirSync(dirname(targetPath), { recursive: true })
    const tmpPath = join(tmpDir, `b2f-${process.pid}-${randomUUID()}`)
    if (entry.mode === '120000') {
      symlinkSync(readBlob(root, entry.version), tmpPath)
      return { targetPath, tmpPath }
    }
    const fd = openSync(tmpPath, 'w')
    try {
      writeSync(fd, readBlobBuffer(root, entry.version))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(tmpPath, entry.mode === '100755' ? 0o755 : 0o644)
    return { targetPath, tmpPath }
  })
  try {
    for (const file of staged) {
      if (file.tmpPath === null) rmSync(file.targetPath, { force: true })
      else renameSync(file.tmpPath, file.targetPath)
    }
  } finally {
    for (const file of staged) {
      if (file.tmpPath !== null) rmSync(file.tmpPath, { force: true })
    }
    sweepTempDir(tmpDir, tempFileKeep)
  }
}

function assertPathInsideRoot(targetPath: string, root: string): void {
  if (!isAbsolute(root)) throw new Error(`block-to-file: root must be absolute (got ${root})`)
  mkdirSync(root, { recursive: true })
  const realRoot = realpathSync(root)
  const segments = relative(root, targetPath).split(sep).filter(segment => segment.length > 0)
  let current = root
  for (const segment of segments) {
    current = join(current, segment)
    if (!existsSync(current)) return
    if (lstatSync(current).isSymbolicLink()) throw new Error(`block-to-file: symlink escape blocked at ${current}`)
    const realCurrent = realpathSync(current)
    if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + sep)) {
      throw new Error(`block-to-file: symlink escape blocked at ${current} (resolves to ${realCurrent})`)
    }
  }
}

function assertGitRoot(root: string): void {
  const top = git(root, ['rev-parse', '--show-toplevel']).trim()
  if (realpathSync(top) !== realpathSync(root)) {
    throw new Error(`block-to-file: root must be the Git worktree root (got ${root}, repository root is ${top})`)
  }
}

function convertNewlines(content: string, newline: FileBlockNewline): string {
  if (newline === 'lf') return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (newline === 'crlf') return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
  return content
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  const newlines = content.match(/\n/g)?.length ?? 0
  return content.endsWith('\n') ? newlines : newlines + 1
}

function selectDiff(full: string | null, strategy: FileBlockDiff, limit: number): string | null {
  if (full === null || strategy === 'none' || strategy === 'stats') return null
  if (strategy === 'full') return full
  const lines = full.split('\n')
  if (lines.length <= limit) return full
  const stats = countDiffStats(lines)
  return `${lines.slice(0, limit).join('\n')}\n[b2f] diff truncated to ${limit} lines (+${stats.added}/-${stats.removed})`
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function git(root: string, args: readonly string[], input?: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function tryGit(root: string, args: readonly string[]): string | null {
  try {
    return git(root, args)
  } catch {
    return null
  }
}
