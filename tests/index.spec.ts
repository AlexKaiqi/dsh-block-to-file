/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as BlockToFile from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const tempRoots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const tmp of tempRoots.splice(0)) rmSync(tmp, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b2f-plugin-'))
  roots.push(root)
  tempRoots.push(`${root}.b2f-tmp`)
  return root
}

function makeAgent(ctx: Context, id: string, root: string, inject: (message: UserMessage) => void): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: root } })
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: ctx.plugin(() => {}).ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject,
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

async function setup(root: string, config: Partial<BlockToFile.Config> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(BlockToFile, Object.assign({ root }, config) as BlockToFile.Config)
  return ctx
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

describe('block-to-file plugin', () => {
  it('materializes file blocks when an assistant message is appended', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const injected: UserMessage[] = []
    const agent = makeAgent(ctx, 'b2f-plugin-session', root, message => injected.push(message))

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-1'),
        role: 'assistant',
        content: [textBlock('```python file=src/app.py\nprint("hello")\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(readFileSync(join(root, 'src/app.py'), 'utf8')).toBe('print("hello")\n')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('[b2f] created src/app.py') }])
  })

  it('does not materialize on validation failure', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const injected: UserMessage[] = []
    const agent = makeAgent(ctx, 'b2f-plugin-invalid', root, message => injected.push(message))

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-2'),
        role: 'assistant',
        content: [textBlock('```python file=../escape.py\nx\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(existsSync(join(root, 'escape.py'))).toBe(false)
    expect(injected).toHaveLength(1)
    expect(injected[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('[b2f] error:') }])
  })

  it('denies tool execution when this step had a b2f validation failure', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const agent = makeAgent(ctx, 'b2f-plugin-tool-deny', root, () => {})

    ctx.tools.register(defineTool({
      name: 'noop',
      description: 'noop',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        return 'ok'
      },
    }))

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-3'),
        role: 'assistant',
        content: [
          textBlock('```python file=../escape.py\nx\n```\n'),
          { type: 'tool-call', id: CallId('call-1'), name: 'noop', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-1'),
      name: 'noop',
      arguments: {},
      agent,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('[b2f] file block validation failed') },
    ])
  })

  it('applies the configured default newline when a block omits newline=', async () => {
    const root = makeRoot()
    const ctx = await setup(root, { newline: 'crlf' })
    const agent = makeAgent(ctx, 'b2f-plugin-newline', root, () => {})

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-newline'),
        role: 'assistant',
        content: [textBlock('```text file=crlf.txt\na\nb\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(readFileSync(join(root, 'crlf.txt'), 'utf8')).toBe('a\r\nb\r\n')
  })

  it('resolves a per-session root through ctx.b2f', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const dynamic = makeRoot()
    ctx.b2f.setRootResolver(() => dynamic)
    const agent = makeAgent(ctx, 'b2f-plugin-dynamic-root', root, () => {})

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-dynamic'),
        role: 'assistant',
        content: [textBlock('```text file=dynamic.txt\ndynamic\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(readFileSync(join(dynamic, 'dynamic.txt'), 'utf8')).toBe('dynamic\n')
    expect(existsSync(join(root, 'dynamic.txt'))).toBe(false)
  })

  it('registers the b2f model-facing prompt section', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const assembly = await ctx.systemPrompt.assemble()
    const text = assembly.sections.map(section => section.text).join('\n')
    expect(text).toContain('file=<relative-path>')
  })
})
