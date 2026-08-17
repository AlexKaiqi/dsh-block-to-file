import { describe, expect, it } from 'vitest'
import { parseFileBlocks } from '../src/parser.ts'

describe('parseFileBlocks', () => {
  it('extracts a file block and keeps content raw', () => {
    const { blocks, errors } = parseFileBlocks('```python file=src/app.py\ndef main():\n    print("hello")\n```\n')
    expect(errors).toEqual([])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.path).toBe('src/app.py')
    expect(blocks[0]!.mode).toBe('write')
    expect(blocks[0]!.content).toBe('def main():\n    print("hello")\n')
  })

  it('ignores ordinary code blocks without file=', () => {
    const { blocks } = parseFileBlocks('```python\nprint("display only")\n```\n')
    expect(blocks).toHaveLength(0)
  })

  it('parses optional attributes and language tag', () => {
    const { blocks } = parseFileBlocks('```python file=src/app.py mode=create diff=none newline=lf\nx\n```\n')
    expect(blocks[0]).toMatchObject({
      path: 'src/app.py',
      mode: 'create',
      diff: 'none',
      newline: 'lf',
      lang: 'python',
    })
  })

  it('supports empty blocks', () => {
    const { blocks } = parseFileBlocks('``` file=empty.txt\n```\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.content).toBe('')
  })

  it('supports longer fences and content containing backticks', () => {
    const { blocks } = parseFileBlocks('````text file=src/doc.md\ncode: ```\n```\n````\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.content).toBe('code: ```\n```\n')
  })

  it('reports unknown and duplicate attributes', () => {
    const { blocks, errors } = parseFileBlocks('```python file=src/a.py mode=write mode=create wut=1\nx\n```\n')
    expect(errors.map(e => e.code)).toEqual(['DUPLICATE_ATTR', 'UNKNOWN_ATTR'])
    expect(blocks).toHaveLength(0)
  })

  it('parses multiple file blocks in message order', () => {
    const { blocks } = parseFileBlocks('```python file=a.py\na\n```\n```python file=b.py\nb\n```\n')
    expect(blocks.map(b => b.path)).toEqual(['a.py', 'b.py'])
  })
})
