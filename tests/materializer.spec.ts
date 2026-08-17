import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeAll, resolveTempDir } from '../src/materializer.ts'
import { parseFileBlocks } from '../src/parser.ts'
import { validateFileBlocks } from '../src/validator.ts'

const roots: string[] = []
const tempRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-materializer-'))
  roots.push(root)
  tempRoots.push(`${root}.b2f-tmp`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const tmp of tempRoots.splice(0)) rmSync(tmp, { recursive: true, force: true })
})

function run(text: string, root: string) {
  const parsed = parseFileBlocks(text)
  const validation = validateFileBlocks(parsed.blocks, {
    root,
    maxFileSize: 1_048_576,
    maxTotalSize: 2_097_152,
    maxFilesPerMessage: 16,
  })
  expect(validation.valid).toBe(true)
  return materializeAll(validation.validated, { root, diffLineLimit: 200, tempFileKeep: 16 })
}

describe('materializeAll', () => {
  it('creates new files including parent directories', () => {
    const root = makeRoot()
    const outcome = run('```python file=src/utils/helpers.py\ndef f():\n    return 1\n```\n', root)
    expect(outcome.errors).toEqual([])
    expect(outcome.results[0]!.status).toBe('created')
    expect(readFileSync(join(root, 'src/utils/helpers.py'), 'utf8')).toBe('def f():\n    return 1\n')
  })

  it('overwrites existing files and reports a diff', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'app.py'), 'def main():\n    print("old")\n    return 0\n')
    const outcome = run('```python file=app.py\ndef main():\n    print("new")\n    return 0\n```\n', root)
    expect(outcome.results[0]!.status).toBe('updated')
    expect(outcome.results[0]!.added).toBe(1)
    expect(outcome.results[0]!.removed).toBe(1)
    expect(outcome.results[0]!.diffText).toContain('+    print("new")')
    expect(outcome.results[0]!.diffText).toContain('-    print("old")')
    expect(readFileSync(join(root, 'app.py'), 'utf8')).toBe('def main():\n    print("new")\n    return 0\n')
  })

  it('appends to existing files and creates missing ones', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'log.txt'), 'a\n')
    const first = run('```text file=log.txt mode=append\nb\nc\n```\n', root)
    expect(first.results[0]!.status).toBe('appended')
    expect(readFileSync(join(root, 'log.txt'), 'utf8')).toBe('a\nb\nc\n')

    const second = run('```text file=new.txt mode=append\nx\n```\n', root)
    expect(second.results[0]!.status).toBe('appended')
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('x\n')
  })

  it('skips append when the content is already present at the end of the file', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'log.txt'), 'a\n')
    const first = run('```text file=log.txt mode=append\nb\n```\n', root)
    expect(first.results[0]?.status).toBe('appended')
    const second = run('```text file=log.txt mode=append\nb\n```\n', root)
    expect(second.results[0]?.status).toBe('unchanged')
    expect(second.results[0]?.added).toBe(0)
    expect(readFileSync(join(root, 'log.txt'), 'utf8')).toBe('a\nb\n')
  })

  it('preserves dollar signs, quotes, and backslashes verbatim', () => {
    const root = makeRoot()
    const content = 'echo "$HOME" \\`backtick\\` \\\\'
    run(`\`\`\`bash file=run.sh\n${content}\n\`\`\`\n`, root)
    expect(readFileSync(join(root, 'run.sh'), 'utf8')).toBe(content + '\n')
  })

  it('creates empty files from empty blocks', () => {
    const root = makeRoot()
    const outcome = run('```text file=empty.txt\n```\n', root)
    expect(outcome.results[0]!.status).toBe('created')
    expect(existsSync(join(root, 'empty.txt'))).toBe(true)
    expect(readFileSync(join(root, 'empty.txt'), 'utf8')).toBe('')
  })

  it('keeps the working tree clean of .b2f directories', () => {
    const root = makeRoot()
    run('```text file=clean.txt\nclean\n```\n', root)
    expect(existsSync(join(root, '.b2f'))).toBe(false)
    expect(existsSync(join(root, 'clean.txt'))).toBe(true)
  })

  it('resolves the temp dir outside the root', () => {
    const root = makeRoot()
    expect(resolveTempDir(root)).toBe(`${root}.b2f-tmp`)
  })

  it('blocks writes through symlinked ancestor directories', () => {
    const root = makeRoot()
    const outside = makeRoot()
    writeFileSync(join(outside, 'escape.txt'), 'outside\n')
    symlinkSync(outside, join(root, 'link'), 'dir')
    const outcome = run('```text file=link/escape.txt\ninside\n```\n', root)
    expect(outcome.errors[0]?.code).toBe('MATERIALIZE_FAILED')
    expect(readFileSync(join(outside, 'escape.txt'), 'utf8')).toBe('outside\n')
  })

  it('normalizes newlines according to the newline attribute', () => {
    const root = makeRoot()
    run('```text file=crlf.txt newline=crlf\na\nb\n```\n', root)
    expect(readFileSync(join(root, 'crlf.txt'), 'utf8')).toBe('a\r\nb\r\n')
  })
})
