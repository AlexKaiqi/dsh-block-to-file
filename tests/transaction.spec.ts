import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFileBlocks } from '../src/parser.ts'
import { commitFileBlocks, fileVersionAt, resolveCanonicalRevision } from '../src/transaction.ts'
import type { ObservedFileProposal, TransactionConfig } from '../src/transaction.ts'
import { validateFileBlocks } from '../src/validator.ts'

const roots: string[] = []
const REF = 'refs/heads/agent-canonical'

function makeRepository(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-transaction-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  execFileSync('git', ['add', '--all'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], { cwd: root, env: gitIdentity() })
  roots.push(root)
  roots.push(`${root}.b2f-tmp`)
  return root
}

function gitIdentity(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
}

function proposals(root: string, revision: string, text: string): ObservedFileProposal[] {
  const parsed = parseFileBlocks(text)
  const validation = validateFileBlocks(parsed.blocks, {
    root,
    maxFileSize: 1_048_576,
    maxTotalSize: 2_097_152,
    maxFilesPerMessage: 16,
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

function commit(root: string, agentId: string, observedRevision: string, text: string) {
  const config: TransactionConfig = {
    root,
    canonicalRef: REF,
    agentId,
    viewRevision: observedRevision,
    diffLineLimit: 200,
    tempFileKeep: 16,
    maxCasRetries: 8,
  }
  return commitFileBlocks(proposals(root, observedRevision, text), config)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Git file transactions', () => {
  it('publishes all blocks in one commit', () => {
    const root = makeRepository()
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=a.txt\na\n```\n```text file=b.txt\nb\n```\n')

    expect(report.status).toBe('committed')
    if (report.status !== 'committed') return
    expect(report.results).toHaveLength(2)
    expect(execFileSync('git', ['rev-parse', `${report.commit}^`], { cwd: root, encoding: 'utf8' }).trim()).toBe(base)
    expect(execFileSync('git', ['show', `${REF}:a.txt`], { cwd: root, encoding: 'utf8' })).toBe('a\n')
    expect(execFileSync('git', ['show', `${REF}:b.txt`], { cwd: root, encoding: 'utf8' })).toBe('b\n')
  })

  it('rejects an entire transaction when one target changed', () => {
    const root = makeRepository({ 'a.txt': 'original\n' })
    const base = resolveCanonicalRevision(root, REF)
    const winner = commit(root, 'agent-b', base, '```text file=a.txt\nwinner\n```\n')
    expect(winner.status).toBe('committed')

    const stale = commit(root, 'agent-a', base, '```text file=a.txt\nloser\n```\n```text file=new.txt\nnew\n```\n')
    expect(stale.status).toBe('stale')
    if (stale.status !== 'stale') return
    expect(stale.staleFiles[0]?.content).toBe('winner\n')
    expect(stale.staleFiles[0]?.changesSinceRead[0]?.agent).toBe('agent-b')
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('winner\n')
    expect(() => readFileSync(join(root, 'new.txt'), 'utf8')).toThrow()
  })

  it('allows a proposal when only unrelated paths changed', () => {
    const root = makeRepository({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' })
    const base = resolveCanonicalRevision(root, REF)
    const first = commit(root, 'agent-b', base, '```text file=b.txt\nb1\n```\n')
    expect(first.status).toBe('committed')
    writeFileSync(join(root, 'b.txt'), 'b0\n')

    const second = commit(root, 'agent-a', base, '```text file=a.txt\na1\n```\n')
    expect(second.status).toBe('committed')
    expect(execFileSync('git', ['show', `${REF}:a.txt`], { cwd: root, encoding: 'utf8' })).toBe('a1\n')
    expect(execFileSync('git', ['show', `${REF}:b.txt`], { cwd: root, encoding: 'utf8' })).toBe('b1\n')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b1\n')
  })

  it('reports create on an existing observation as a precondition failure', () => {
    const root = makeRepository({ 'existing.txt': 'old\n' })
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=existing.txt mode=create\nnew\n```\n')

    expect(report.status).toBe('precondition-failed')
    if (report.status !== 'precondition-failed') return
    expect(report.errors[0]?.code).toBe('FILE_EXISTS')
    expect(report.files[0]).toMatchObject({
      path: 'existing.txt',
      content: 'old\n',
    })
  })

  it('reports update on an absent observation as a precondition failure', () => {
    const root = makeRepository()
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=missing.txt mode=update\nnew\n```\n')

    expect(report.status).toBe('precondition-failed')
    if (report.status !== 'precondition-failed') return
    expect(report.errors[0]?.code).toBe('FILE_NOT_FOUND')
    expect(report.files[0]).toMatchObject({
      path: 'missing.txt',
      content: null,
      fileVersion: 'absent',
    })
  })

  it('treats a create target appearing after observation as stale', () => {
    const root = makeRepository()
    const base = resolveCanonicalRevision(root, REF)
    const winner = commit(root, 'agent-b', base, '```text file=new.txt\nwinner\n```\n')
    expect(winner.status).toBe('committed')

    const report = commit(root, 'agent-a', base, '```text file=new.txt mode=create\nloser\n```\n')
    expect(report.status).toBe('stale')
    if (report.status !== 'stale') return
    expect(report.staleFiles[0]).toMatchObject({
      path: 'new.txt',
      content: 'winner\n',
      observedVersion: 'absent',
    })
  })

  it('updates an existing file with mode=update', () => {
    const root = makeRepository({ 'existing.txt': 'old\n' })
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=existing.txt mode=update\nnew\n```\n')

    expect(report.status).toBe('committed')
    if (report.status !== 'committed') return
    expect(report.results[0]?.status).toBe('updated')
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('new\n')
  })

  it('reports append to an absent path as created', () => {
    const root = makeRepository()
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=log.txt mode=append\nfirst\n```\n')

    expect(report.status).toBe('committed')
    if (report.status !== 'committed') return
    expect(report.results[0]?.status).toBe('created')
    expect(readFileSync(join(root, 'log.txt'), 'utf8')).toBe('first\n')
  })

  it('deletes an existing path from canonical and worktree', () => {
    const root = makeRepository({ 'old.txt': 'old\ncontent\n' })
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(root, 'agent-a', base, '```text file=old.txt mode=delete\n```\n')

    expect(report.status).toBe('committed')
    if (report.status !== 'committed') return
    expect(report.results[0]).toMatchObject({ status: 'deleted', removed: 2 })
    expect(fileVersionAt(root, report.repoRevision, 'old.txt')).toBe('absent')
    expect(() => readFileSync(join(root, 'old.txt'), 'utf8')).toThrow()
  })

  it('returns unchanged without a commit for satisfied operations', () => {
    const root = makeRepository({ 'same.txt': 'same\n' })
    const base = resolveCanonicalRevision(root, REF)
    const report = commit(
      root,
      'agent-a',
      base,
      '```text file=same.txt mode=update\nsame\n```\n```text file=missing.txt mode=delete\n```\n',
    )

    expect(report.status).toBe('unchanged')
    if (report.status !== 'unchanged') return
    expect(report.commit).toBeNull()
    expect(report.repoRevision).toBe(base)
    expect(report.results.map(result => result.status)).toEqual(['unchanged', 'unchanged'])
    expect(resolveCanonicalRevision(root, REF)).toBe(base)
  })

  it('rejects a transaction that would overwrite worktree drift', () => {
    const root = makeRepository({ 'local.txt': 'canonical\n' })
    const base = resolveCanonicalRevision(root, REF)
    rmSync(join(root, 'local.txt'))

    const report = commit(root, 'agent-a', base, '```text file=local.txt mode=update\nproposed\n```\n')
    expect(report.status).toBe('worktree-dirty')
    if (report.status !== 'worktree-dirty') return
    expect(report.dirtyFiles[0]).toMatchObject({
      path: 'local.txt',
      content: null,
      fileVersion: 'absent',
    })
    expect(resolveCanonicalRevision(root, REF)).toBe(base)
  })

  it('allows a path changed and restored to the observed blob', () => {
    const root = makeRepository({ 'a.txt': 'same\n' })
    const base = resolveCanonicalRevision(root, REF)
    const changed = commit(root, 'agent-b', base, '```text file=a.txt\ntemporary\n```\n')
    expect(changed.status).toBe('committed')
    if (changed.status !== 'committed') return
    const restored = commit(root, 'agent-b', changed.repoRevision, '```text file=a.txt\nsame\n```\n')
    expect(restored.status).toBe('committed')

    const report = commit(root, 'agent-a', base, '```text file=a.txt\naccepted\n```\n')
    expect(report.status).toBe('committed')
  })

  it('preserves executable mode in the commit and worktree projection', () => {
    const root = makeRepository({ 'run.sh': '#!/bin/sh\necho old\n' })
    chmodSync(join(root, 'run.sh'), 0o755)
    execFileSync('git', ['add', 'run.sh'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'make executable'], { cwd: root, env: gitIdentity() })
    const base = resolveCanonicalRevision(root, REF)

    const report = commit(root, 'agent-a', base, '```bash file=run.sh\n#!/bin/sh\necho new\n```\n')
    expect(report.status).toBe('committed')
    expect(execFileSync('git', ['ls-tree', REF, '--', 'run.sh'], { cwd: root, encoding: 'utf8' })).toMatch(/^100755 /)
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755)
  })
})
