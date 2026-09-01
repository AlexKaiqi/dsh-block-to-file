import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFileBlocks } from '../src/parser.ts'
import { validateFileBlocks } from '../src/validator.ts'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-validator-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function validate(text: string, root: string, overrides: Partial<Parameters<typeof validateFileBlocks>[1]> = {}) {
  const parsed = parseFileBlocks(text)
  return validateFileBlocks(parsed.blocks, {
    root,
    maxFileSize: 1_048_576,
    maxTotalSize: 2_097_152,
    maxFilesPerMessage: 16,
    ...overrides,
  })
}

describe('validateFileBlocks', () => {
  it('accepts a normal relative path', () => {
    const root = makeRoot()
    const result = validate('```python file=src/app.py\nx\n```\n', root)
    expect(result.valid).toBe(true)
    expect(result.validated[0]!.normalizedPath).toBe('src/app.py')
    expect(result.validated[0]!.targetPath).toBe(join(root, 'src/app.py'))
  })

  it('rejects absolute paths, drive letters, and escape segments', () => {
    const root = makeRoot()
    expect(validate('```python file=/abs.py\nx\n```\n', root).errors[0]!.code).toBe('PATH_ABSOLUTE')
    expect(validate('```python file=C:\\abs.py\nx\n```\n', root).errors[0]!.code).toBe('PATH_ABSOLUTE')
    expect(validate('```python file=../x.py\nx\n```\n', root).errors[0]!.code).toBe('PATH_ESCAPE')
    expect(validate('```python file=a/../../b.py\nx\n```\n', root).errors[0]!.code).toBe('PATH_ESCAPE')
  })

  it('accepts an absolute path that resolves inside the root', () => {
    const root = makeRoot()
    const inside = validate('```python file=' + root + '/src/app.py\nx\n```\n', root)
    expect(inside.valid).toBe(true)
    expect(inside.validated[0]!.normalizedPath).toBe('src/app.py')
    expect(inside.validated[0]!.targetPath).toBe(join(root, 'src/app.py'))

    const dots = validate('```python file=' + root + '/src/../lib/a.py\nx\n```\n', root)
    expect(dots.valid).toBe(true)
    expect(dots.validated[0]!.normalizedPath).toBe('lib/a.py')
  })

  it('rejects absolute paths that escape the root', () => {
    const root = makeRoot()
    expect(validate('```python file=/etc/passwd\nx\n```\n', root).errors[0]!.code).toBe('PATH_ABSOLUTE')
    expect(validate('```python file=' + root + '/../sibling.py\nx\n```\n', root).errors[0]!.code).toBe('PATH_ABSOLUTE')
  })

  it('rejects duplicate paths in one message', () => {
    const root = makeRoot()
    const result = validate('```python file=src/app.py\na\n```\n```python file=src/app.py\nb\n```\n', root)
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain('DUPLICATE_PATH')
  })

  it('leaves mode=create existence checks to the atomic transaction', () => {
    const root = makeRoot()
    const result = validate('```python file=existing.py mode=create\nnew\n```\n', root)
    expect(result.valid).toBe(true)
  })

  it('rejects invalid mode, diff, encoding, and newline', () => {
    const root = makeRoot()
    const result = validate('```python file=a.py mode=bad diff=bad encoding=latin1 newline=bad\nx\n```\n', root)
    expect(result.errors.map(e => e.code)).toEqual([
      'INVALID_MODE',
      'INVALID_DIFF',
      'INVALID_ENCODING',
      'INVALID_NEWLINE',
    ])
  })

  it('rejects lone surrogate code points as ENCODING_INVALID', () => {
    const root = makeRoot()
    const text = '```python file=bad.py\n' + String.fromCharCode(0xD800) + '\n```\n'
    const result = validate(text, root)
    expect(result.errors.map(e => e.code)).toContain('ENCODING_INVALID')
  })

  it('enforces per-file, total, and file-count limits', () => {
    const root = makeRoot()
    const big = validate('```python file=big.py\n' + 'x'.repeat(1000) + '\n```\n', root, { maxFileSize: 10 })
    expect(big.errors[0]!.code).toBe('SIZE_EXCEEDED')

    const total = validate('```python file=a.py\n' + 'x'.repeat(50) + '\n```\n```python file=b.py\n' + 'y'.repeat(50) + '\n```\n', root, { maxTotalSize: 60 })
    expect(total.errors.map(e => e.code)).toContain('TOTAL_SIZE_EXCEEDED')

    const count = validate('```python file=a.py\na\n```\n```python file=b.py\nb\n```\n', root, { maxFilesPerMessage: 1 })
    expect(count.errors.map(e => e.code)).toContain('TOO_MANY_FILES')
  })
})
