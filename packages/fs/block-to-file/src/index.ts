/**
 * block-to-file (b2f) runtime pipeline plugin.
 *
 * b2f materializes fenced code blocks whose info string carries a `file=`
 * attribute into the workspace BEFORE any tool call of the same assistant
 * message executes. It is not a tool: it listens to `session/event` for
 * `assistant/message`, validates and writes files synchronously, injects a
 * `[b2f]` feedback message for the next step, and denies tool execution when
 * validation failed.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { execFileSync } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { parseFileBlocks } from './parser.ts'
import { validateFileBlocks } from './validator.ts'
import { materializeAll, sweepTempDir } from './materializer.ts'
import { renderFeedback } from './feedback.ts'
import { DEFAULT_PROMPT } from './prompt.ts'
import type { B2FError, B2FReport, StepB2FState } from './types.ts'

export const name = 'block-to-file'
export const inject = ['systemPrompt', 'tools', 'agents']

/** Deployment configuration for the b2f pipeline. */
export interface Config {
  /** Enable file-block materialization. */
  enabled: boolean
  /** Workspace root. `$WS` expands to the process `WS` env var; `$DSH_B2F_ROOT` is expanded too. */
  root: string
  maxFileSize: number
  maxTotalSize: number
  maxFilesPerMessage: number
  diffLineLimit: number
  gitStatusFeedback: boolean
  tempFileKeep: number
  newline: 'preserve' | 'lf' | 'crlf'
  prompt: string
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('$WS'),
  maxFileSize: z.number().default(1_048_576),
  maxTotalSize: z.number().default(2_097_152),
  maxFilesPerMessage: z.number().default(16),
  diffLineLimit: z.number().default(200),
  tempFileKeep: z.number().default(16),
  gitStatusFeedback: z.boolean().default(true),
  newline: z.union(['preserve', 'lf', 'crlf'] as const).default('preserve'),
  prompt: z.string().default(DEFAULT_PROMPT),
})

interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly maxFileSize: number
  readonly maxTotalSize: number
  readonly maxFilesPerMessage: number
  readonly diffLineLimit: number
  readonly gitStatusFeedback: boolean
  readonly tempFileKeep: number
  readonly newline: 'preserve' | 'lf' | 'crlf'
  readonly prompt: string
}

/**
 * Register the b2f pipeline.
 * @param ctx - registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  sweepTempDir(join(resolved.root, '.b2f', 'tmp'), resolved.tempFileKeep)
  const state = new Map<string, StepB2FState>()

  ctx.systemPrompt.section({
    name: 'b2f:write-files',
    order: 90,
    text: resolved.prompt,
  })

  // Phase 1-3: parse, validate, and materialize synchronously inside the
  // `assistant/message` append so every file exists before tool execution.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'step/end') {
      state.delete(stateKey(session.id, event.data.turn, event.data.step))
      return
    }
    if (event.type !== 'assistant/message') return

    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return

    const report = runPipeline(event.data.message.content, resolved)
    const feedback = renderFeedback(report)
    const key = stateKey(session.id, event.data.turn, event.data.step)
    state.set(key, { turn: event.data.turn, step: event.data.step, report, feedback })

    if (feedback.length === 0) return
    queueMicrotask(() => {
      injectFeedback(agent, feedback)
    })
  })

  // Phase gate: never let a tool call run when this step's file blocks failed
  // validation (they were not materialized).
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const current = currentAssistant(agent)
    if (current === undefined) return next()
    const stepState = state.get(stateKey(agent.id, current.turn, current.step))
    if (stepState !== undefined && !stepState.report.ok && stepState.report.results.length === 0) {
      return {
        kind: 'deny',
        reason: '[b2f] file block validation failed; see the [b2f] error feedback for fixes.',
      }
    }
    return next()
  })
}

/** Run parse → validate → materialize for one assistant message. */
function runPipeline(content: readonly ContentBlock[], config: ResolvedConfig): B2FReport {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')

  const parsed = parseFileBlocks(text, config.newline)
  if (!isWellFormedUtf16(text)) {
    return {
      ok: false,
      results: [],
      errors: [{ code: 'ENCODING_INVALID', path: null, hint: 'emit valid UTF-8 text only (no unpaired surrogate code points)' }],
      gitStatus: null,
    }
  }
  const validation = validateFileBlocks(parsed.blocks, {
    root: config.root,
    maxFileSize: config.maxFileSize,
    maxTotalSize: config.maxTotalSize,
    maxFilesPerMessage: config.maxFilesPerMessage,
  })

  const errors: B2FError[] = [...parsed.errors, ...validation.errors]
  if (errors.length > 0) {
    return { ok: false, results: [], errors, gitStatus: null }
  }

  const outcome = materializeAll(validation.validated, {
    root: config.root,
    diffLineLimit: config.diffLineLimit,
    tempFileKeep: config.tempFileKeep,
  })
  if (outcome.errors.length > 0) {
    return { ok: false, results: outcome.results, errors: outcome.errors, gitStatus: null }
  }

  return {
    ok: true,
    results: outcome.results,
    errors: [],
    gitStatus: config.gitStatusFeedback ? readGitStatus(config.root) : null,
  }
}

/** Resolve and validate configuration, failing loud on a bad root. */
function resolveConfig(config: Config): ResolvedConfig {
  if (!config.enabled) {
    return {
      enabled: false,
      root: '',
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
      maxFilesPerMessage: config.maxFilesPerMessage,
      diffLineLimit: config.diffLineLimit,
      gitStatusFeedback: config.gitStatusFeedback,
      tempFileKeep: config.tempFileKeep,
      newline: config.newline,
      prompt: config.prompt,
    }
  }
  assertValidLimits(config)
  const envRoot = process.env.DSH_B2F_ROOT
  const expanded = (envRoot ?? config.root)
    .replaceAll('$WS', process.env.WS ?? '')
    .replaceAll('$DSH_B2F_ROOT', process.env.DSH_B2F_ROOT ?? '')
  const raw = expanded.trim().length > 0 ? expanded : process.cwd()
  if (!isAbsolute(raw)) {
    throw new Error(`block-to-file: root must be an absolute path (resolved "${raw}"). Set DSH_B2F_ROOT or configure b2f.root.`)
  }
  return {
    enabled: true,
    root: resolve(raw),
    maxFileSize: config.maxFileSize,
    maxTotalSize: config.maxTotalSize,
    maxFilesPerMessage: config.maxFilesPerMessage,
    diffLineLimit: config.diffLineLimit,
    gitStatusFeedback: config.gitStatusFeedback,
    tempFileKeep: config.tempFileKeep,
    newline: config.newline,
    prompt: config.prompt,
  }
}

/** Fail fast on invalid limits; these are deployment errors, not model errors. */
function assertValidLimits(config: Config): void {
  const positiveIntegers: [string, number][] = [
    ['maxFileSize', config.maxFileSize],
    ['maxTotalSize', config.maxTotalSize],
    ['maxFilesPerMessage', config.maxFilesPerMessage],
    ['diffLineLimit', config.diffLineLimit],
    ['tempFileKeep', config.tempFileKeep],
  ]
  for (const [field, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`block-to-file: ${field} must be a positive safe integer (got ${JSON.stringify(value)})`)
    }
  }
  if (config.maxTotalSize < config.maxFileSize) {
    throw new Error(`block-to-file: maxTotalSize (${config.maxTotalSize}) must be >= maxFileSize (${config.maxFileSize})`)
  }
  if (config.prompt.trim().length === 0) {
    throw new Error('block-to-file: prompt must be non-empty')
  }
}

/** True when the string contains only valid Unicode code points, i.e. no lone surrogates. */
function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

function stateKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}:${turn}:${step}`
}

/** Find the assistant message event owning the current step. */
function currentAssistant(agent: Agent): { turn: number; step: number } | undefined {
  const event = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return undefined
  return { turn: event.data.turn, step: event.data.step }
}

/** Inject `[b2f]` feedback into the next step without waking an idle driver. */
function injectFeedback(agent: Agent, feedback: string): void {
  try {
    agent.inject(createUserMessage({
      source: { kind: 'plugin', plugin: 'b2f', form: 'notice', summary: feedback.split('\n')[0] ?? 'b2f feedback' },
      content: [{ type: 'text', text: feedback }],
    }))
  } catch (error: unknown) {
    // Injection failures are contained: file materialization already happened.
    void error
  }
}

/** Best-effort `git status --short` snapshot; no git repository yields null. */
function readGitStatus(root: string): string | null {
  try {
    const output = execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const text = output.trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
