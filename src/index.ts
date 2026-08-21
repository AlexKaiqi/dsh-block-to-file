/**
 * block-to-file (b2f) runtime pipeline plugin.
 *
 * b2f commits fenced code blocks whose info string carries a `file=`
 * attribute BEFORE any tool call of the same assistant message executes. It
 * is not a tool: it validates all blocks, compares their observed Git blobs,
 * publishes one commit with ref CAS, injects `[b2f]` feedback, and denies tool
 * execution unless the whole transaction committed.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { parseFileBlocks as parseBlocks } from './parser.ts'
import { validateFileBlocks as validateBlocks } from './validator.ts'
import { assertTempDirOutsideRoot as assertTmpOutside, resolveGitDir, resolveTempDir, sweepTempDir } from './materializer.ts'
import { renderFeedback as renderB2FFeedback } from './feedback.ts'
import { DEFAULT_MAX_DRIFT } from './edit.ts'
import { buildPrompt, DEFAULT_PROMPT } from './model/prompt.ts'
import { B2FService as B2FServiceClass } from './service.ts'
import type { B2FError, B2FReport, EditFormat } from './types.ts'

export { parseFileBlocks } from './parser.ts'
export type { ParseResult } from './parser.ts'
export { validateFileBlocks } from './validator.ts'
export type { B2FValidationConfig, ValidatedFileBlock, ValidationResult } from './validator.ts'
export { assertTempDirOutsideRoot, resolveGitDir, resolveTempDir, sweepTempDir } from './materializer.ts'
export { DEFAULT_MAX_DRIFT, editError, resolveEdit } from './edit.ts'
export type { EditFailure, EditOutcome, EditResolution } from './edit.ts'
export { b2fError, BlockToFileError, isB2FError } from './errors.ts'
export { buildPrompt, DEFAULT_PROMPT, GIT_DIFF_PROMPT, REPLACE_PROMPT } from './model/prompt.ts'
export { commitFileBlocks, fileVersionAt, projectRevision, resolveCanonicalRevision, resolveWorktreeRevision } from './transaction.ts'
export type { ObservedFileProposal, TransactionConfig } from './transaction.ts'
export { renderEditUnresolvedFeedback, renderFailureFeedback, renderFeedback, renderProjectionFailureFeedback, renderStaleFeedback, renderSuccessFeedback } from './feedback.ts'
export { countDiffStats, unifiedDiff } from './diff.ts'
export type { DiffHunk } from './diff.ts'
export { B2FService } from './service.ts'
export type { B2FCommitConfig, B2FRootResolver } from './service.ts'
export { EDIT_MODE_FOR_FORMAT } from './types.ts'
export type { B2FCommittedReport, B2FEditUnresolvedReport, B2FError, B2FErrorCode, B2FFailedReport, B2FPreconditionFailedReport, B2FProjectionFailedReport, B2FReport, B2FStaleReport, B2FUnchangedReport, B2FWorktreeDirtyReport, ChangeSinceRead, DirtyFile, EditFormat, FileBlock, FileBlockDiff, FileBlockEncoding, FileBlockMode, FileBlockNewline, FileObservation, FileVersion, MaterializeResult, MaterializeStatus, PreconditionFile, StaleFile, StepB2FState } from './types.ts'

export const name = 'block-to-file'
export const inject = ['systemPrompt', 'tools', 'agents']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One b2f transaction settled. Carries the full report, including per-block
     * `editFormat` / `editsProposed` / `editsApplied` / `fuzz`, so an external
     * consumer can compute first-apply success rate, retry counts, and drift
     * tolerance per edit dialect without this plugin aggregating anything.
     * @param session - the session whose assistant message produced the blocks.
     * @param report - the settled transactional outcome.
     * @mode emit
     */
    'b2f/transaction'(session: Session, report: B2FReport): void
  }
}

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
  /** Canonical Git ref published with compare-and-swap. */
  canonicalRef: string
  /** Maximum retries when unrelated concurrent commits win the ref CAS. */
  maxCasRetries: number
  tempFileKeep: number
  newline: 'preserve' | 'lf' | 'crlf'
  /**
   * Which partial-edit dialect to expose. Exactly one is offered to the model,
   * so it never has to choose a patch format; the other is rejected with a
   * corrective error. `none` disables partial edits entirely.
   */
  editFormat: EditFormat
  /** Lines a `mode=diff` hunk may drift from its stated start line. */
  maxEditDrift: number
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
  canonicalRef: z.string().default('refs/heads/agent-canonical'),
  maxCasRetries: z.number().default(8),
  tempFileKeep: z.number().default(16),
  newline: z.union(['preserve', 'lf', 'crlf'] as const).default('preserve'),
  editFormat: z.union(['git_diff', 'replace', 'none'] as const).default('git_diff'),
  maxEditDrift: z.number().default(DEFAULT_MAX_DRIFT),
  prompt: z.string().default(DEFAULT_PROMPT),
})

interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly maxFileSize: number
  readonly maxTotalSize: number
  readonly maxFilesPerMessage: number
  readonly diffLineLimit: number
  readonly canonicalRef: string
  readonly maxCasRetries: number
  readonly tempFileKeep: number
  readonly newline: 'preserve' | 'lf' | 'crlf'
  readonly editFormat: EditFormat
  readonly maxEditDrift: number
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
  const defaultTmp = resolveTempDir(resolved.root)
  assertTmpOutside(defaultTmp, resolved.root)
  assertTmpOutside(resolveGitDir(resolved.root), resolved.root)
  sweepTempDir(defaultTmp, resolved.tempFileKeep)
  new B2FServiceClass(ctx, resolved.root)
  const deniedCalls = new Map<string, string>()
  const callsByStep = new Map<string, readonly string[]>()

  ctx.systemPrompt.section({
    name: 'b2f:write-files',
    order: 90,
    text: buildPrompt(resolved.prompt, resolved.editFormat),
  })

  // Capture the immutable repository view on which the next model decision is based.
  ctx.on('agent/pre-step', async (payload, next) => {
    ctx.b2f.captureSnapshot(payload.agent, payload.agent.session, resolved.canonicalRef, resolved.tempFileKeep)
    return next()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const prefix = `${agent.id}:`
    for (const key of deniedCalls.keys()) {
      if (key.startsWith(prefix)) deniedCalls.delete(key)
    }
    for (const key of callsByStep.keys()) {
      if (key.startsWith(prefix)) callsByStep.delete(key)
    }
  })

  // Parse, validate, compare, and publish synchronously before same-message tools.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'step/end') {
      const stepKey = stateKey(session.id, event.data.turn, event.data.step)
      for (const key of callsByStep.get(stepKey) ?? []) deniedCalls.delete(key)
      callsByStep.delete(stepKey)
      return
    }
    if (event.type !== 'assistant/message') return

    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const report = runPipeline(event.data.message.content, resolved, agent, session, ctx.b2f)
    if (report === null) return
    // Line-anchored dialects need numbered echoes so the model can re-anchor;
    // content-anchored ones need verbatim text to copy.
    const feedback = renderB2FFeedback(report, resolved.editFormat === 'git_diff')
    if (!report.ok) {
      const callKeys = event.data.message.content
        .filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call')
        .map(block => callKey(session.id, block.id))
      for (const key of callKeys) deniedCalls.set(key, report.status)
      if (callKeys.length > 0) {
        callsByStep.set(stateKey(session.id, event.data.turn, event.data.step), callKeys)
      }
    }
    try {
      ctx.emit('b2f/transaction', session, report)
    } catch {
      // Observation failures cannot change an already settled transaction.
    }

    queueMicrotask(() => {
      injectFeedback(agent, feedback)
    })
  })

  // Only tool calls emitted beside a failed transaction are denied. Correlating
  // by rootCallId also covers nested Code Mode dispatch without leaking failure
  // state into a later model step.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const status = deniedCalls.get(callKey(agent.id, exec.rootCallId))
    if (status !== undefined) {
      return {
        kind: 'deny',
        reason: `[b2f] file transaction ${status}; see the [b2f] feedback before retrying.`,
      }
    }
    return next()
  })
}

/** Run parse → validate → compare-and-commit for one assistant message. */
function runPipeline(
  content: readonly ContentBlock[],
  config: ResolvedConfig,
  agent: Agent,
  session: Session,
  service: B2FServiceClass,
): B2FReport | null {
  const text = content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    // Content blocks are semantic boundaries, not streaming chunks. Keep a
    // line boundary between them so a closing fence at the end of one block
    // cannot be fused with ordinary reply text in the next block.
    .join('\n')

  const parsed = parseBlocks(text, config.newline)
  if (parsed.blocks.length === 0 && parsed.errors.length === 0) return null
  if (!isWellFormedUtf16(text)) {
    return failedReport([{
      code: 'ENCODING_INVALID',
      path: null,
      hint: 'emit valid UTF-8 text only (no unpaired surrogate code points)',
    }])
  }
  const paths = parsed.blocks.map(block => block.path)
  const root = service.resolveRoot(agent, session, paths)
  const validation = validateBlocks(parsed.blocks, {
    root,
    maxFileSize: config.maxFileSize,
    maxTotalSize: config.maxTotalSize,
    maxFilesPerMessage: config.maxFilesPerMessage,
    editFormat: config.editFormat,
  })

  const errors: B2FError[] = [...parsed.errors, ...validation.errors]
  if (errors.length > 0) return failedReport(errors)

  return service.commit(agent, session, validation.validated, {
    canonicalRef: config.canonicalRef,
    diffLineLimit: config.diffLineLimit,
    tempFileKeep: config.tempFileKeep,
    maxCasRetries: config.maxCasRetries,
    maxEditDrift: config.maxEditDrift,
  }, root)
}

function failedReport(errors: readonly B2FError[]): B2FReport {
  return {
    status: 'failed',
    ok: false,
    commit: null,
    repoRevision: null,
    results: [],
    errors,
    staleFiles: [],
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
      canonicalRef: config.canonicalRef,
      maxCasRetries: config.maxCasRetries,
      tempFileKeep: config.tempFileKeep,
      newline: config.newline,
      editFormat: config.editFormat,
      maxEditDrift: config.maxEditDrift,
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
    canonicalRef: config.canonicalRef,
    maxCasRetries: config.maxCasRetries,
    tempFileKeep: config.tempFileKeep,
    newline: config.newline,
    editFormat: config.editFormat,
    maxEditDrift: config.maxEditDrift,
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
    ['maxCasRetries', config.maxCasRetries],
    ['tempFileKeep', config.tempFileKeep],
    ['maxEditDrift', config.maxEditDrift],
  ]
  for (const [field, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`block-to-file: ${field} must be a positive safe integer (got ${JSON.stringify(value)})`)
    }
  }
  if (config.maxTotalSize < config.maxFileSize) {
    throw new Error(`block-to-file: maxTotalSize (${config.maxTotalSize}) must be >= maxFileSize (${config.maxFileSize})`)
  }
  if (!config.canonicalRef.startsWith('refs/')) {
    throw new Error(`block-to-file: canonicalRef must be a fully qualified refs/... name (got ${JSON.stringify(config.canonicalRef)})`)
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

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`
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
