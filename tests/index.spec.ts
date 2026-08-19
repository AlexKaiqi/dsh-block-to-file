/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { parseFileBlocks } from '../src/parser.ts'
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
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root })
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'initial'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
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

/** Git identity for fixture commits made outside the plugin. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  }
}

/** Append a one-text-block assistant message, the event b2f reacts to. */
function appendAssistant(agent: Agent, id: string, text: string, turn = 1, step = 1): void {
  agent.session.append('assistant/message', {
    turn,
    step,
    message: {
      id: MessageId(id),
      role: 'assistant',
      content: [textBlock(text)],
      source: { kind: 'model', provider: 'test', model: 'test' },
    },
  }, { surfaceOp: 'append' })
}

/** Concatenated text of an injected `[b2f]` feedback message. */
function feedbackText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
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
      { type: 'text', text: expect.stringContaining('[b2f] file transaction failed') },
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

  it('uses the session cwd as the default repository root', async () => {
    const fallback = makeRoot()
    const sessionRoot = makeRoot()
    const ctx = await setup(fallback)
    const agent = makeAgent(ctx, 'b2f-plugin-session-root', sessionRoot, () => {})

    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-session-root'),
        role: 'assistant',
        content: [textBlock('```text file=session.txt\nsession\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(readFileSync(join(sessionRoot, 'session.txt'), 'utf8')).toBe('session\n')
    expect(existsSync(join(fallback, 'session.txt'))).toBe(false)
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

  it('returns stale content and treats it as the next observation', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const feedbackA: UserMessage[] = []
    const agentA = makeAgent(ctx, 'agent-a', root, message => feedbackA.push(message))
    const agentB = makeAgent(ctx, 'agent-b', root, () => {})
    ctx.b2f.captureSnapshot(agentA, agentA.session, 'refs/heads/agent-canonical')
    ctx.b2f.captureSnapshot(agentB, agentB.session, 'refs/heads/agent-canonical')

    agentB.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-winner'),
        role: 'assistant',
        content: [textBlock('```text file=shared.txt\nwinner\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    agentA.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('msg-stale'),
        role: 'assistant',
        content: [textBlock('```text file=shared.txt\nloser\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(feedbackA[0]?.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('[b2f] stale: transaction rejected'),
    }])
    expect(feedbackA[0]?.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('winner'),
    }])

    agentA.session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        id: MessageId('msg-retry'),
        role: 'assistant',
        content: [textBlock('```text file=shared.txt\nretry\n```\n')],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    }, { surfaceOp: 'append' })
    await Promise.resolve()

    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('retry\n')
    expect(feedbackA[1]?.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('[b2f] committed'),
    }])
  })


  it('registers the b2f model-facing prompt section', async () => {
    const root = makeRoot()
    const ctx = await setup(root)
    const assembly = await ctx.systemPrompt.assemble()
    const text = assembly.sections.map(section => section.text).join('\n')
    expect(text).toContain('file=<relative-path>')
  })

  it('exposes only the active edit dialect in the assembled prompt', async () => {
    const gitDiff = await setup(makeRoot(), { editFormat: 'git_diff' })
    const gitDiffText = (await gitDiff.systemPrompt.assemble()).sections.map(section => section.text).join('\n')
    expect(gitDiffText).toContain('mode=diff')
    expect(gitDiffText).not.toContain('<<<<<<< SEARCH')

    const replace = await setup(makeRoot(), { editFormat: 'replace' })
    const replaceText = (await replace.systemPrompt.assemble()).sections.map(section => section.text).join('\n')
    expect(replaceText).toContain('<<<<<<< SEARCH')
    expect(replaceText).not.toContain('mode=diff')

    const none = await setup(makeRoot(), { editFormat: 'none' })
    const noneText = (await none.systemPrompt.assemble()).sections.map(section => section.text).join('\n')
    expect(noneText).not.toContain('<<<<<<< SEARCH')
    expect(noneText).not.toContain('mode=diff')
    expect(noneText).toContain('file=<relative-path>')
  })

  it('applies a partial edit end to end through the plugin', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'client.py'), 'timeout = 1\nretries = 0\n')
    execFileSync('git', ['add', '--all'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root, env: gitEnv() })

    const ctx = await setup(root, { editFormat: 'replace' })
    const injected: UserMessage[] = []
    const agent = makeAgent(ctx, 'b2f-plugin-edit', root, message => injected.push(message))

    appendAssistant(agent, 'msg-edit', '```python file=client.py mode=edit\n<<<<<<< SEARCH\ntimeout = 1\n=======\ntimeout = 3\n>>>>>>> REPLACE\n```\n')
    await Promise.resolve()

    expect(readFileSync(join(root, 'client.py'), 'utf8')).toBe('timeout = 3\nretries = 0\n')
    expect(injected[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('[b2f] committed') }])
  })

  it('rejects the inactive edit mode without writing', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'client.py'), 'timeout = 1\n')
    execFileSync('git', ['add', '--all'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root, env: gitEnv() })

    const ctx = await setup(root, { editFormat: 'git_diff' })
    const injected: UserMessage[] = []
    const agent = makeAgent(ctx, 'b2f-plugin-wrong-mode', root, message => injected.push(message))

    appendAssistant(agent, 'msg-wrong', '```python file=client.py mode=edit\n<<<<<<< SEARCH\ntimeout = 1\n=======\ntimeout = 3\n>>>>>>> REPLACE\n```\n')
    await Promise.resolve()

    expect(readFileSync(join(root, 'client.py'), 'utf8')).toBe('timeout = 1\n')
    expect(injected[0]!.content).toEqual([{ type: 'text', text: expect.stringContaining('EDIT_MODE_DISABLED') }])
  })

  it('returns the current content for re-anchoring when an edit does not resolve', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'client.py'), 'timeout = 1\n')
    execFileSync('git', ['add', '--all'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root, env: gitEnv() })

    const ctx = await setup(root, { editFormat: 'replace' })
    const injected: UserMessage[] = []
    const agent = makeAgent(ctx, 'b2f-plugin-unresolved', root, message => injected.push(message))

    appendAssistant(agent, 'msg-unresolved', '```python file=client.py mode=edit\n<<<<<<< SEARCH\nNOPE\n=======\nx\n>>>>>>> REPLACE\n```\n')
    await Promise.resolve()

    expect(readFileSync(join(root, 'client.py'), 'utf8')).toBe('timeout = 1\n')
    const text = feedbackText(injected[0]!)
    expect(text).toContain('[b2f] edit not applied')
    expect(text).toContain('EDIT_SEARCH_NOT_FOUND')
    // The echo is inert: `path=` is not a write instruction.
    expect(text).toContain('path=client.py')
    expect(parseFileBlocks(text).blocks).toEqual([])
  })

  it('emits b2f/transaction with per-block edit metrics', async () => {
    const root = makeRoot()
    writeFileSync(join(root, 'client.py'), 'timeout = 1\n')
    execFileSync('git', ['add', '--all'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root, env: gitEnv() })

    const ctx = await setup(root, { editFormat: 'replace' })
    const reports: BlockToFile.B2FReport[] = []
    ctx.on('b2f/transaction', (_session, report) => {
      reports.push(report)
    })
    const agent = makeAgent(ctx, 'b2f-plugin-metrics', root, () => {})

    appendAssistant(agent, 'msg-metrics', '```python file=client.py mode=edit\n<<<<<<< SEARCH\ntimeout = 1\n=======\ntimeout = 3\n>>>>>>> REPLACE\n```\n')
    await Promise.resolve()

    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('committed')
    expect(reports[0]?.results[0]).toMatchObject({
      editFormat: 'replace',
      editsProposed: 1,
      editsApplied: 1,
      fuzz: 0,
    })
  })

  it('numbers echoed content only for the line-anchored dialect', async () => {
    for (const [editFormat, expectNumbered] of [['git_diff', true], ['replace', false]] as const) {
      const root = makeRoot()
      writeFileSync(join(root, 'client.py'), 'alpha\nbeta\n')
      execFileSync('git', ['add', '--all'], { cwd: root })
      execFileSync('git', ['commit', '--quiet', '-m', 'seed'], { cwd: root, env: gitEnv() })

      const ctx = await setup(root, { editFormat })
      const injected: UserMessage[] = []
      const agent = makeAgent(ctx, `b2f-plugin-numbered-${editFormat}`, root, message => injected.push(message))

      // mode=create on an existing path fails its precondition and echoes content.
      appendAssistant(agent, `msg-numbered-${editFormat}`, '```python file=client.py mode=create\nx\n```\n')
      await Promise.resolve()

      const text = feedbackText(injected[0]!)
      expect(text).toContain('FILE_EXISTS')
      expect(text.includes('1: alpha')).toBe(expectNumbered)
    }
  })
})
