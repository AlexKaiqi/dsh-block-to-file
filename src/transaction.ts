import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { editError, resolveEdit } from './edit.ts'
import { assertTempDirOutsideRoot, resolveGitDir, resolveTempDir, sweepTempDir } from './materializer.ts'
import { ERROR_HINTS } from './types.ts'
import type { ValidatedFileBlock } from './validator.ts'
import type {
  B2FError,
  B2FReport,
  ChangeSinceRead,
  DirtyFile,
  EditFormat,
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
  /** Line tolerance for `mode=diff` anchor search. */
  readonly maxEditDrift: number
}

interface Candidate {
  readonly path: string
  readonly mode: FileBlockMode
  readonly expectedVersion: FileVersion
  readonly observedRevision: string
  readonly content: string | null
  readonly preconditionError: B2FError | null
  /** Set when an edit block's anchors did not resolve against observed content. */
  readonly resolutionError: B2FError | null
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

interface SnapshotEntry {
  readonly path: string
  readonly mode: '100644' | '100755' | '120000'
}

const BOOTSTRAP_REF = 'refs/b2f/bootstrap'
const ZERO_OID = '0000000000000000000000000000000000000000'

/** Resolve the current canonical commit, initializing the ref from the managed baseline once. */
export function resolveCanonicalRevision(root: string, canonicalRef: string): string {
  ensureManagedRepository(root)
  const current = tryGit(root, ['rev-parse', '--verify', canonicalRef])
  if (current !== null) return current.trim()
  const head = git(root, ['rev-parse', '--verify', BOOTSTRAP_REF]).trim()
  tryGit(root, ['update-ref', canonicalRef, head, ZERO_OID])
  return git(root, ['rev-parse', '--verify', canonicalRef]).trim()
}

/** Resolve the plugin-owned baseline used as the initial projection revision. */
export function resolveWorktreeRevision(root: string): string {
  ensureManagedRepository(root)
  return git(root, ['rev-parse', '--verify', BOOTSTRAP_REF]).trim()
}

/** Return the blob identity for a path at one repository revision. */
export function fileVersionAt(root: string, revision: string, path: string): FileVersion {
  ensureManagedRepository(root)
  return treeEntryAt(root, revision, path).version
}

/** Compare every observed path and publish all proposed contents in one commit. */
export function commitFileBlocks(
  proposals: readonly ObservedFileProposal[],
  config: TransactionConfig,
): B2FReport {
  try {
    ensureManagedRepository(config.root)
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
        return {
          status: 'precondition-failed',
          ok: false,
          commit: null,
          repoRevision: head,
          results: [],
          errors: preconditionErrors,
          staleFiles: [],
          files: echoFiles(config.root, head, preconditionErrors),
        }
      }

      // Checked after staleness so a concurrently changed file reports `stale`
      // with fresh content rather than a misleading anchor error, and after
      // preconditions so an absent file reports FILE_NOT_FOUND. Past both, the
      // observed content IS current content, so an anchor failure is
      // unambiguously the model's to fix and echoing that content is correct.
      const resolutionErrors = candidates
        .map(candidate => candidate.resolutionError)
        .filter((error): error is B2FError => error !== null)
      if (resolutionErrors.length > 0) {
        return {
          status: 'edit-unresolved',
          ok: false,
          commit: null,
          repoRevision: head,
          results: [],
          errors: resolutionErrors,
          staleFiles: [],
          files: echoFiles(config.root, head, resolutionErrors),
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

/**
 * Read the current content of each errored path so the model can retry at once.
 * Callers must have already cleared the staleness check, which is what makes
 * this content both current and the right basis for a corrected proposal.
 */
function echoFiles(root: string, head: string, errors: readonly B2FError[]): PreconditionFile[] {
  const seen = new Set<string>()
  const files: PreconditionFile[] = []
  for (const error of errors) {
    const path = error.path
    if (path === null || seen.has(path)) continue
    seen.add(path)
    const version = fileVersionAt(root, head, path)
    files.push({
      path,
      content: version === 'absent' ? null : readBlob(root, version),
      fileVersion: version,
    })
  }
  return files
}

function buildCandidate(proposal: ObservedFileProposal, config: TransactionConfig): Candidate {
  const { block, normalizedPath } = proposal.entry
  const mode = block.mode as FileBlockMode
  const expectedVersion = proposal.observation.fileVersion
  const previous = readObservedContent(config.root, expectedVersion)

  let content: string | null = null
  let status: MaterializeResult['status'] = 'unchanged'
  let added = 0
  let removed = 0
  let rawDiff: string | null = null
  let resolutionError: B2FError | null = null
  let editFormat: Exclude<EditFormat, 'none'> | null = null
  let editsProposed = 0
  let editsApplied = 0
  let fuzz = 0

  switch (mode) {
    case 'write':
    case 'create':
    case 'update': {
      const proposed = convertNewlines(block.content, block.newline as FileBlockNewline)
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
    case 'edit':
    case 'diff': {
      editFormat = mode === 'edit' ? 'replace' : 'git_diff'
      // An edit resolves against the exact observed bytes and preserves the
      // file's own line endings, so `newline=` is never applied here; the
      // validator rejects it explicitly rather than silently ignoring it.
      if (expectedVersion === 'absent') {
        // Reported as a precondition failure below; content is never consumed.
        content = previous
        break
      }
      const outcome = resolveEdit(editFormat, block.content, previous, config.maxEditDrift)
      editsProposed = outcome.editsProposed
      editsApplied = outcome.editsApplied
      if (!outcome.ok) {
        resolutionError = editError(outcome, normalizedPath)
        // NEVER null: `null` content means "delete this path" in buildTree, and
        // an unresolved edit must not be able to express deletion. The CAS loop
        // returns on `resolutionError` before this value is read.
        content = previous
        break
      }
      content = outcome.content
      fuzz = outcome.fuzz
      status = previous === content ? 'unchanged' : 'updated'
      rawDiff = unifiedDiff(previous, content, `a/${normalizedPath}`, `b/${normalizedPath}`)
      const stats = rawDiff === null ? { added: 0, removed: 0 } : countDiffStats(rawDiff.split('\n'))
      added = stats.added
      removed = stats.removed
      break
    }
    case 'append': {
      const proposed = convertNewlines(block.content, block.newline as FileBlockNewline)
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
    : (mode === 'update' || mode === 'edit' || mode === 'diff') && expectedVersion === 'absent'
        ? { code: 'FILE_NOT_FOUND' as const, path: normalizedPath, hint: ERROR_HINTS.FILE_NOT_FOUND }
        : null

  return {
    path: normalizedPath,
    mode,
    expectedVersion,
    observedRevision: proposal.observation.repoRevision,
    content,
    preconditionError,
    resolutionError,
    result: {
      path: normalizedPath,
      mode,
      status,
      lines: content === null ? 0 : countLines(content),
      added,
      removed,
      diffText: selectDiff(rawDiff, block.diff as FileBlockDiff, config.diffLineLimit),
      editFormat,
      editsProposed,
      editsApplied,
      fuzz,
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
  return git(root, ['hash-object', '--stdin'], buffer).trim()
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
    env: managedGitEnv(root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Project the complete canonical delta so the agent worktree matches its new revision. */
export function projectRevision(root: string, fromRevision: string, toRevision: string, tempFileKeep: number): void {
  ensureManagedRepository(root)
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

function git(root: string, args: readonly string[], input?: string | Buffer, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: managedGitEnv(root, env),
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

/** Ensure the workspace has an isolated object database without creating `<root>/.git`. */
function ensureManagedRepository(root: string): void {
  if (!isAbsolute(root)) throw new Error(`block-to-file: root must be absolute (got ${root})`)
  mkdirSync(root, { recursive: true })
  const gitDir = resolveGitDir(root)
  assertTempDirOutsideRoot(gitDir, root)
  if (existsSync(join(gitDir, 'HEAD'))
    && tryGit(root, ['rev-parse', '--verify', BOOTSTRAP_REF]) !== null) {
    return
  }

  mkdirSync(dirname(gitDir), { recursive: true })
  if (!existsSync(join(gitDir, 'HEAD'))) {
    execFileSync('git', ['init', '--bare', '--quiet', gitDir], {
      cwd: root,
      env: sourceGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  const existing = tryGit(root, ['rev-parse', '--verify', BOOTSTRAP_REF])
  if (existing === null) {
    const tree = snapshotWorkspaceTree(root)
    const env = gitIdentityEnv()
    const commit = git(root, ['commit-tree', tree], 'b2f: bootstrap workspace\n', env).trim()
    tryGit(root, ['update-ref', BOOTSTRAP_REF, commit, ZERO_OID])
    git(root, ['rev-parse', '--verify', BOOTSTRAP_REF])
  }
}

/** Capture the current workspace without descending into nested `.git` stores. */
function snapshotWorkspaceTree(root: string): string {
  const entries = collectSnapshotEntries(root)
  const indexPath = join(resolveTempDir(root), `bootstrap-index-${process.pid}-${randomUUID()}`)
  mkdirSync(dirname(indexPath), { recursive: true })
  const env = { ...process.env, GIT_INDEX_FILE: indexPath }
  try {
    git(root, ['read-tree', '--empty'], undefined, env)
    const indexRecords: string[] = []
    const regular = entries.filter(entry => entry.mode !== '120000')
    for (let offset = 0; offset < regular.length; offset += 1_000) {
      const batch = regular.slice(offset, offset + 1_000)
      const safe: SnapshotEntry[] = []
      const unsafe: SnapshotEntry[] = []
      for (const entry of batch) {
        if (entry.path.includes('\n') || entry.path.includes('\r') || entry.path.startsWith('"')) unsafe.push(entry)
        else safe.push(entry)
      }
      if (safe.length > 0) {
        const output = git(root, ['hash-object', '-w', '--stdin-paths'], `${safe.map(entry => entry.path).join('\n')}\n`)
        const oids = output.trimEnd().split('\n')
        if (oids.length !== safe.length) throw new Error('block-to-file: Git returned an incomplete bootstrap hash list')
        for (let index = 0; index < safe.length; index++) {
          indexRecords.push(`${safe[index]!.mode} ${oids[index]!}\t${safe[index]!.path}\0`)
        }
      }
      for (const entry of unsafe) {
        const oid = git(root, ['hash-object', '-w', '--stdin'], readFileSync(join(root, entry.path))).trim()
        indexRecords.push(`${entry.mode} ${oid}\t${entry.path}\0`)
      }
    }
    for (const entry of entries.filter(candidate => candidate.mode === '120000')) {
      const oid = git(root, ['hash-object', '-w', '--stdin'], Buffer.from(readlinkSync(join(root, entry.path)))).trim()
      indexRecords.push(`${entry.mode} ${oid}\t${entry.path}\0`)
    }
    for (let offset = 0; offset < indexRecords.length; offset += 1_000) {
      git(root, ['update-index', '-z', '--index-info'], indexRecords.slice(offset, offset + 1_000).join(''), env)
    }
    return git(root, ['write-tree'], undefined, env).trim()
  } finally {
    rmSync(indexPath, { force: true })
  }
}

function collectSnapshotEntries(root: string): SnapshotEntry[] {
  const byPath = new Map<string, SnapshotEntry>()

  const addPath = (absolutePath: string): void => {
    const stat = lstatSync(absolutePath)
    if (!stat.isFile() && !stat.isSymbolicLink()) return
    const path = relative(root, absolutePath).split(sep).join('/')
    if (path.length === 0) return
    const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) !== 0 ? '100755' : '100644'
    byPath.set(path, { path, mode })
  }

  const visit = (directory: string): void => {
    const gitFiles = listGitWorkspaceFiles(directory)
    if (gitFiles !== null) {
      for (const path of gitFiles) {
        const absolutePath = join(directory, path)
        if (existsSync(absolutePath)) addPath(absolutePath)
      }
      return
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolutePath)
      else if (entry.isFile() || entry.isSymbolicLink()) addPath(absolutePath)
    }
  }

  visit(root)
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Return tracked files when `directory` is itself a Git worktree root. */
function listGitWorkspaceFiles(directory: string): string[] | null {
  if (!existsSync(join(directory, '.git'))) return null
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      env: sourceGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (realpathSync(top) !== realpathSync(directory)) return null
    return execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: directory,
      encoding: 'utf8',
      env: sourceGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(path => path.length > 0)
  } catch {
    return null
  }
}

function managedGitEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_DIR: resolveGitDir(root), GIT_WORK_TREE: root }
  delete env.GIT_COMMON_DIR
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return env
}

function sourceGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_COMMON_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_OBJECT_DIRECTORY
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return env
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'block-to-file',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'b2f@localhost',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'block-to-file',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'b2f@localhost',
  }
}
