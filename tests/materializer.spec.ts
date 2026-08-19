import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertTempDirOutsideRoot, resolveTempDir, sweepTempDir } from '../src/materializer.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-materializer-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveTempDir', () => {
  it('resolves a sibling of the root, never inside it', () => {
    const root = makeRoot()
    expect(resolveTempDir(root)).toBe(`${root}.b2f-tmp`)
  })

  it('ignores a trailing separator when deriving the sibling', () => {
    expect(resolveTempDir('/tmp/example/')).toBe('/tmp/example.b2f-tmp')
  })

  it('honors DSH_B2F_TMP when it is set', () => {
    const previous = process.env.DSH_B2F_TMP
    process.env.DSH_B2F_TMP = '/tmp/b2f-override'
    try {
      expect(resolveTempDir('/tmp/example')).toBe('/tmp/b2f-override')
    } finally {
      if (previous === undefined) delete process.env.DSH_B2F_TMP
      else process.env.DSH_B2F_TMP = previous
    }
  })
})

describe('assertTempDirOutsideRoot', () => {
  it('accepts a sibling directory', () => {
    expect(() => assertTempDirOutsideRoot('/tmp/example.b2f-tmp', '/tmp/example')).not.toThrow()
  })

  it('rejects the root itself and any descendant', () => {
    expect(() => assertTempDirOutsideRoot('/tmp/example', '/tmp/example')).toThrow(/must be outside/)
    expect(() => assertTempDirOutsideRoot('/tmp/example/.b2f', '/tmp/example')).toThrow(/must be outside/)
  })
})

describe('sweepTempDir', () => {
  it('is a no-op for a directory that does not exist', () => {
    expect(() => sweepTempDir(join(makeRoot(), 'absent'), 4)).not.toThrow()
  })
})
