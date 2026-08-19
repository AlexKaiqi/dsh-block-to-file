/**
 * L2 durability behavior: idempotent replay, crash residue reconciliation, and
 * concurrent-writer recovery.
 *
 * These assert REAL behavior against real repositories. A crash is simulated by
 * leaving behind exactly the state a killed process would leave — an unswept
 * temp file, an advanced canonical ref, a projected-but-uncommitted worktree —
 * and then asserting the next real run reconciles it. No mocks, and no keyword
 * bait: every case fails the process if the invariant breaks.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFileBlocks } from '../src/parser.ts'
import { commitFileBlocks, fileVersionAt, resolveCanonicalRevision } from '../src/transaction.ts'
import type { ObservedFileProposal, TransactionConfig } from '../src/transaction.ts'
import { resolveTempDir, sweepTempDir } from '../src/materializer.ts'
import { validateFileBlocks } from '../src/validator.ts'

const roots: string[] = []
const REF = 'refs/heads/agent-canonical'

function gitIdentity(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
}

function makeRepository(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-durability-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  execFileSync('git', ['add', '--all'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], { cwd: root, env: gitIdentity() })
  roots.push(root, `${root}.b2f-tmp`)
  return root
}

function proposals(root: string, revision: string, text: string): ObservedFileProposal[] {
  const parsed = parseFileBlocks(text)
  const validation = validateFileBlocks(parsed.blocks, {
    root,
    maxFileSize: 1_048_576,
    maxTotalSize: 2_097_152,
    maxFilesPerMessage: 16,
    editFormat: 'replace',
  })
  expect(validation.errors).toEqual([])
  return validation.validated.map(entry => ({
    entry,
    observation: {
      path: entry.normalizedPath,
      fileVersion: fileVersionAt(root, revision, entry.normalizedPath),
      repoRevision: revision,
    },
  }))
}

function commit(root: string, agentId: string, observedRevision: string, text: string, tempFileKeep = 16) {
  const config: TransactionConfig = {
    root,
    canonicalRef: REF,
    agentId,
    viewRevision: observedRevision,
    diffLineLimit: 200,
    tempFileKeep,
    maxCasRetries: 8,
    maxEditDrift: 200,
  }
  return commitFileBlocks(proposals(root, observedRevision, text), config)
}

/** Commits reachable from the canonical ref, newest first. */
function refLog(root: string): string[] {
  return execFileSync('git', ['rev-list', REF], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(line => line.length > 0)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('idempotent replay', () => {
  it('replaying an identical message creates no second commit', () => {
    const root = makeRepository({ 'a.txt': 'v0\n' })
    const base = resolveCanonicalRevision(root, REF)

    const first = commit(root, 'agent-a', base, '```text file=a.txt\nv1\n```\n')
    expect(first.status).toBe('committed')
    if (first.status !== 'committed') return
    const afterFirst = refLog(root)

    // The same message replayed against the NEW observation is a no-op.
    const replay = commit(root, 'agent-a', first.repoRevision, '```text file=a.txt\nv1\n```\n')
    expect(replay.status).toBe('unchanged')
    expect(replay.commit).toBeNull()
    expect(refLog(root)).toEqual(afterFirst)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n')
  })

  it('replaying an identical edit block is idempotent', () => {
    const root = makeRepository({ 'a.txt': 'timeout = 1\n' })
    const base = resolveCanonicalRevision(root, REF)
    const block = '```text file=a.txt mode=edit\n<<<<<<< SEARCH\ntimeout = 1\n=======\ntimeout = 3\n>>>>>>> REPLACE\n```\n'

    const first = commit(root, 'agent-a', base, block)
    expect(first.status).toBe('committed')
    if (first.status !== 'committed') return

    // The anchor is gone after the first apply, so a replay must NOT silently
    // succeed or double-apply; it reports an unresolved anchor and changes nothing.
    const replay = commit(root, 'agent-a', first.repoRevision, block)
    expect(replay.status).toBe('edit-unresolved')
    expect(replay.commit).toBeNull()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('timeout = 3\n')
    expect(resolveCanonicalRevision(root, REF)).toBe(first.repoRevision)
  })

  it('append is idempotent across repeated delivery of the same block', () => {
    const root = makeRepository({ 'log.txt': 'a\n' })
    const base = resolveCanonicalRevision(root, REF)

    const first = commit(root, 'agent-a', base, '```text file=log.txt mode=append\nb\n```\n')
    expect(first.status).toBe('committed')
    if (first.status !== 'committed') return

    const replay = commit(root, 'agent-a', first.repoRevision, '```text file=log.txt mode=append\nb\n```\n')
    expect(replay.status).toBe('unchanged')
    expect(readFileSync(join(root, 'log.txt'), 'utf8')).toBe('a\nb\n')
  })
})

describe('crash recovery', () => {
  it('recovers when a previous run died after committing but before projecting', () => {
    const root = makeRepository({ 'a.txt': 'v0\n' })
    const base = resolveCanonicalRevision(root, REF)

    // Simulate a process killed between `update-ref` and `projectRevision`:
    // canonical has advanced, but the worktree still holds the observed bytes.
    const winner = commit(root, 'agent-b', base, '```text file=a.txt\ncommitted\n```\n')
    expect(winner.status).toBe('committed')
    if (winner.status !== 'committed') return
    writeFileSync(join(root, 'a.txt'), 'v0\n')

    // The worktree matches the OBSERVED blob, so it is not local drift — it is
    // simply an un-projected view. Staleness is therefore the right report: the
    // model gets the committed content back instead of a drift complaint.
    const next = commit(root, 'agent-a', base, '```text file=a.txt\nnext\n```\n')
    expect(next.status).toBe('stale')
    expect(next.commit).toBeNull()
    if (next.status !== 'stale') return
    expect(next.staleFiles[0]?.content).toBe('committed\n')
    // Canonical is untouched, and recovery re-projects the worktree so the next
    // attempt observes reality rather than the stale view.
    expect(resolveCanonicalRevision(root, REF)).toBe(winner.repoRevision)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('committed\n')
  })

  it('leaves no partial commit when one block of a message is unpublishable', () => {
    const root = makeRepository({ 'a.txt': 'a0\n' })
    const base = resolveCanonicalRevision(root, REF)
    const before = refLog(root)

    // `mode=create` on an existing path fails its precondition; the sibling
    // block is perfectly valid and must still not reach the repository.
    const report = commit(
      root,
      'agent-a',
      base,
      '```text file=fresh.txt\nfresh\n```\n```text file=a.txt mode=create\nclash\n```\n',
    )
    expect(report.status).toBe('precondition-failed')
    expect(refLog(root)).toEqual(before)
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false)
    expect(fileVersionAt(root, resolveCanonicalRevision(root, REF), 'fresh.txt')).toBe('absent')
  })

  it('reconciles a concurrent writer without losing either commit', () => {
    const root = makeRepository({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
    const base = resolveCanonicalRevision(root, REF)

    // Two agents publish disjoint paths from the same observation. The loser of
    // the ref CAS must rebuild on the winner's head, keeping both changes.
    const first = commit(root, 'agent-b', base, '```text file=b.txt\nb1\n```\n')
    expect(first.status).toBe('committed')
    if (first.status !== 'committed') return
    const second = commit(root, 'agent-a', base, '```text file=a.txt\na1\n```\n')
    expect(second.status).toBe('committed')
    if (second.status !== 'committed') return

    expect(execFileSync('git', ['show', `${REF}:a.txt`], { cwd: root, encoding: 'utf8' })).toBe('a1\n')
    expect(execFileSync('git', ['show', `${REF}:b.txt`], { cwd: root, encoding: 'utf8' })).toBe('b1\n')
    // The winner's commit is an ancestor: history is linear, nothing was discarded.
    expect(refLog(root)).toContain(first.repoRevision)
    expect(execFileSync('git', ['rev-parse', `${second.repoRevision}^`], { cwd: root, encoding: 'utf8' }).trim())
      .toBe(first.repoRevision)
  })

  it('a killed write leaves recoverable residue outside the worktree, never a partial target', () => {
    const root = makeRepository({ 'a.txt': 'v0\n' })
    const tmpDir = resolveTempDir(root)
    mkdirSync(tmpDir, { recursive: true })

    // Exactly what a process killed mid-write leaves: a staged temp file that
    // was never renamed over its target.
    const orphan = join(tmpDir, `b2f-${process.pid}-crashed`)
    writeFileSync(orphan, 'half-written bytes')

    // The residue is outside the worktree, so the repository is still clean.
    expect(tmpDir.startsWith(root + '/')).toBe(false)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v0\n')

    // A later run sweeps it: residue is bounded, not accumulated forever.
    sweepTempDir(tmpDir, 0)
    expect(existsSync(orphan)).toBe(false)
  })

  it('bounds temp residue to the configured retention across many transactions', () => {
    const root = makeRepository()
    const tmpDir = resolveTempDir(root)
    mkdirSync(tmpDir, { recursive: true })
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(tmpDir, `b2f-${process.pid}-old-${index}`), 'residue')
    }

    // A real transaction sweeps on its way through projection.
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=a.txt\nv1\n```\n', 4)
    expect(report.status).toBe('committed')

    const remaining = readdirSync(tmpDir)
    expect(remaining.length).toBeLessThanOrEqual(4)
    // The published content is unaffected by sweeping.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n')
  })

  it('a corrupted canonical ref fails loudly instead of publishing', () => {
    const root = makeRepository({ 'a.txt': 'v0\n' })
    const base = resolveCanonicalRevision(root, REF)
    // Point the ref at a non-existent object, as a torn ref update would.
    writeFileSync(join(root, '.git', REF), `${'0'.repeat(40)}\n`)

    const report = commit(root, 'agent-a', base, '```text file=a.txt\nv1\n```\n')
    expect(report.ok).toBe(false)
    expect(report.status).toBe('failed')
    // The worktree was not touched on the way to failing.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v0\n')
  })
})
