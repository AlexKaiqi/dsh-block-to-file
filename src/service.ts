/**
 * Standalone observation and transaction service for block-to-file.
 *
 * The service owns agent snapshots and explicit path observations. A dynamic
 * root resolver is a generic checkout/sandbox facility; no downstream plugin
 * participates in b2f's Git concurrency semantics.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { commitFileBlocks, fileVersionAt, projectRevision, resolveCanonicalRevision, resolveWorktreeRevision } from './transaction.ts'
import type { TransactionConfig } from './transaction.ts'
import type {
  B2FCommittedReport,
  B2FPublicationReceipt,
  B2FReport,
  B2FUnchangedReport,
  FileObservation,
} from './types.ts'
import type { ValidatedFileBlock } from './validator.ts'
import { BlockToFileError } from './errors.ts'

export interface B2FRootScope {
  readonly root: string
  readonly scope: string
  /** A trusted Host mount may replace the Session workspace-write root. */
  readonly authorization?: 'session' | 'mounted-workspace'
}

export type B2FRootResolution = string | B2FRootScope | undefined
export type B2FRootResolver = (
  agent?: Agent,
  session?: Session,
  paths?: readonly string[],
) => B2FRootResolution | Promise<B2FRootResolution>

export interface B2FCommitConfig {
  readonly canonicalRef: string
  readonly diffLineLimit: number
  readonly tempFileKeep: number
  readonly maxCasRetries: number
  readonly maxEditDrift: number
}

export interface B2FPublicationRequest {
  readonly agent: Agent
  readonly session: Session
  readonly root: string
  readonly scope: string
  readonly paths: readonly string[]
  readonly report: B2FCommittedReport | B2FUnchangedReport
}

export type B2FPublisher = (
  request: B2FPublicationRequest,
) => B2FPublicationReceipt | undefined | Promise<B2FPublicationReceipt | undefined>

interface AgentSnapshot {
  readonly root: string
  readonly repoRevision: string
}

interface SandboxPolicyContract {
  resolve(request?: { readonly session?: Session }): {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly workspaceRoot: string
  }
}

interface FileSystemContract {
  resolve(path: string, options?: { readonly cwd?: string }): Promise<object>
  stat(target: object): Promise<{ readonly type: 'file' | 'directory' | 'other'; readonly version: unknown } | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    b2f: B2FService
  }
}

/** Standalone b2f service registered as `ctx.b2f`. */
export class B2FService extends Service {
  private readonly context: Context
  private readonly fallbackResolver: (agent?: Agent, session?: Session) => string
  private readonly resolvers: Array<{ readonly resolve: B2FRootResolver }> = []
  private readonly publishers: Array<{ readonly publish: B2FPublisher }> = []
  private readonly snapshots = new Map<string, AgentSnapshot>()
  private readonly observations = new Map<string, Map<string, FileObservation>>()

  constructor(ctx: Context, fallbackRoot: string) {
    super(ctx, 'b2f')
    this.context = ctx
    this.fallbackResolver = (_agent, session) => session?.header.cwd ?? fallbackRoot
    ctx.on('agent/disposed', ({ agent }) => {
      this.releaseAgent(String(agent.id))
    })
  }

  /**
   * Register a synchronous resolver for per-agent checkouts or sandboxes.
   *
   * Registrations are consulted newest-first; returning `undefined` delegates
   * to older registrations and finally the Session workspace. The disposer
   * removes exactly this registration so consumers unwind independently.
   */
  registerRootResolver(resolver: B2FRootResolver): () => void {
    const entry = { resolve: resolver }
    this.resolvers.push(entry)
    return () => {
      const index = this.resolvers.lastIndexOf(entry)
      if (index >= 0) this.resolvers.splice(index, 1)
    }
  }

  /** @deprecated Use `registerRootResolver()` and retain its disposer. */
  setRootResolver(resolver: B2FRootResolver): () => void {
    return this.registerRootResolver(resolver)
  }

  /** Register an optional external canonical publisher for successful transactions. */
  registerPublisher(publisher: B2FPublisher): () => void {
    const entry = { publish: publisher }
    this.publishers.push(entry)
    return () => {
      const index = this.publishers.lastIndexOf(entry)
      if (index >= 0) this.publishers.splice(index, 1)
    }
  }

  /** Whether publication may add an asynchronous settlement barrier. */
  hasPublishers(): boolean {
    return this.publishers.length > 0
  }

  /** Whether successful writes should bridge into the shared fs observation policy. */
  hasFileSystemObserver(): boolean {
    return this.context.get('fs') !== undefined
  }

  /** Record provider-native versions after b2f has settled its workspace files. */
  async observeFileSystem(request: B2FPublicationRequest): Promise<void> {
    const fileSystem = this.context.get('fs') as FileSystemContract | undefined
    if (fileSystem === undefined) return
    const emit = this.context.emit.bind(this.context) as (event: string, ...args: unknown[]) => unknown
    await Promise.all(request.report.results.map(async (result) => {
      try {
        const target = await fileSystem.resolve(result.path, { cwd: request.root })
        const info = await fileSystem.stat(target)
        if (info !== undefined && info.type !== 'file') return
        const observation = info === undefined
          ? { kind: 'absent' as const }
          : { kind: 'present' as const, version: info.version }
        emit('fs/observed', target, observation, { agent: request.agent })
      } catch {
        // Observation interoperability cannot change an already settled write.
      }
    }))
  }

  /** Publish through the newest integration that claims this transaction. */
  async publish(request: B2FPublicationRequest): Promise<readonly B2FPublicationReceipt[]> {
    for (let index = this.publishers.length - 1; index >= 0; index -= 1) {
      const receipt = await this.publishers[index]?.publish(request)
      if (receipt !== undefined) return [receipt]
    }
    return []
  }

  /**
   * Resolve a root synchronously for compatibility and pre-step snapshots.
   * Roots that need asynchronous preparation must go through {@link resolveScope}
   * instead; synchronous callers that cannot await it (pre-step snapshots) skip
   * the snapshot and let the commit path capture it on demand.
   */
  resolveRoot(agent?: Agent, session?: Session, paths?: readonly string[]): string {
    const scope = this.resolveScope(agent, session, paths)
    if (isPromiseLike(scope)) {
      throw new BlockToFileError(
        'MATERIALIZE_FAILED',
        null,
        'this root requires asynchronous preparation; resolve the scope through the async path before committing.',
      )
    }
    return scope.root
  }

  /** Resolve one formal scope and reject transactions spanning multiple mounts. */
  resolveScope(
    agent?: Agent,
    session?: Session,
    paths?: readonly string[],
  ): B2FRootScope | Promise<B2FRootScope> {
    if (paths === undefined || paths.length === 0) return this.resolveSingleScope(agent, session)
    const scopes = paths.map(path => this.resolveSingleScope(agent, session, [path]))
    if (scopes.some(isPromiseLike)) {
      return Promise.all(scopes).then(resolved => assertSingleScope(resolved))
    }
    return assertSingleScope(scopes as B2FRootScope[])
  }

  /** Apply the shared Session sandbox policy to one resolved transaction scope. */
  authorizeScope(scope: B2FRootScope, session?: Session): void {
    const sandboxPolicy = this.context.get('sandboxPolicy') as SandboxPolicyContract | undefined
    const policy = sandboxPolicy?.resolve(session === undefined ? undefined : { session })
    if (policy === undefined || policy.mode === 'danger-full-access') return
    if (policy.mode === 'read-only') {
      throw new BlockToFileError('SANDBOX_DENIED', null, 'the Session sandbox is read-only.')
    }
    if (scope.authorization === 'mounted-workspace' || containsPath(policy.workspaceRoot, scope.root)) return
    throw new BlockToFileError(
      'SANDBOX_DENIED',
      null,
      `scope '${scope.scope}' is outside the Session workspace-write root.`,
    )
  }

  private resolveSingleScope(
    agent?: Agent,
    session?: Session,
    paths?: readonly string[],
    index = this.resolvers.length - 1,
  ): B2FRootScope | Promise<B2FRootScope> {
    if (index < 0) {
      return { root: resolvePath(this.fallbackResolver(agent, session)), scope: 'workspace', authorization: 'session' }
    }
    const resolution = this.resolvers[index]?.resolve(agent, session, paths)
    if (isPromiseLike(resolution)) {
      return resolution.then(value => value === undefined
        ? this.resolveSingleScope(agent, session, paths, index - 1)
        : normalizeRootScope(value))
    }
    return resolution === undefined
      ? this.resolveSingleScope(agent, session, paths, index - 1)
      : normalizeRootScope(resolution)
  }

  /** Release all observation state owned by one disposed Agent. */
  releaseAgent(agentId: string): void {
    this.snapshots.delete(agentId)
    this.observations.delete(agentId)
  }

  /** Capture the canonical repository snapshot visible to the next model step. */
  captureSnapshot(
    agent: Agent,
    session: Session,
    canonicalRef: string,
    tempFileKeep = 16,
    root = this.resolveRoot(agent, session),
  ): string {
    const previous = this.snapshots.get(agent.id)
    if (previous?.root === root) return previous.repoRevision

    const repoRevision = resolveCanonicalRevision(root, canonicalRef)
    projectRevision(root, resolveWorktreeRevision(root), repoRevision, tempFileKeep)
    this.snapshots.set(agent.id, { root, repoRevision })
    this.observations.delete(agent.id)
    return repoRevision
  }

  /** Record an exact observation made by any read-capable runtime plugin. */
  recordObservation(agentId: string, observation: FileObservation): void {
    let byPath = this.observations.get(agentId)
    if (byPath === undefined) {
      byPath = new Map()
      this.observations.set(agentId, byPath)
    }
    byPath.set(observation.path, observation)
  }

  /** Compare all target observations and publish one canonical Git commit. */
  commit(
    agent: Agent,
    session: Session,
    validated: readonly ValidatedFileBlock[],
    config: B2FCommitConfig,
    root = this.resolveRoot(agent, session, validated.map(entry => entry.normalizedPath)),
  ): B2FReport {
    let snapshot = this.snapshots.get(agent.id)
    if (snapshot === undefined || snapshot.root !== root) {
      const repoRevision = this.captureSnapshot(agent, session, config.canonicalRef, config.tempFileKeep, root)
      snapshot = { root, repoRevision }
    }
    const explicit = this.observations.get(agent.id)
    const proposals = validated.map((entry) => ({
      entry,
      observation: explicit?.get(entry.normalizedPath) ?? {
        path: entry.normalizedPath,
        fileVersion: fileVersionAt(root, snapshot.repoRevision, entry.normalizedPath),
        repoRevision: snapshot.repoRevision,
      },
    }))
    const transactionConfig: TransactionConfig = {
      root,
      canonicalRef: config.canonicalRef,
      agentId: agent.id,
      viewRevision: snapshot.repoRevision,
      diffLineLimit: config.diffLineLimit,
      tempFileKeep: config.tempFileKeep,
      maxCasRetries: config.maxCasRetries,
      maxEditDrift: config.maxEditDrift,
    }
    const report = commitFileBlocks(proposals, transactionConfig)
    this.absorb(agent.id, root, validated, report)
    return report
  }

  /**
   * Advance this agent's snapshot and per-path observations from one outcome.
   *
   * Exhaustive over `B2FReport['status']`: a new status must state its
   * observation policy here rather than silently inheriting "record nothing",
   * which would leave the agent observing a revision it can no longer see.
   */
  private absorb(
    agentId: string,
    root: string,
    validated: readonly ValidatedFileBlock[],
    report: B2FReport,
  ): void {
    switch (report.status) {
      // Publication settled: the agent now observes what it just wrote.
      case 'committed':
      case 'unchanged': {
        this.snapshots.set(agentId, { root, repoRevision: report.repoRevision })
        for (const entry of validated) {
          this.recordObservation(agentId, {
            path: entry.normalizedPath,
            fileVersion: fileVersionAt(root, report.repoRevision, entry.normalizedPath),
            repoRevision: report.repoRevision,
          })
        }
        return
      }

      // Rejected, but the feedback handed the model fresh content: adopt it as
      // the new observation so an immediate retry compares against reality.
      case 'stale': {
        this.snapshots.set(agentId, { root, repoRevision: report.repoRevision })
        for (const file of report.staleFiles) {
          this.recordObservation(agentId, {
            path: file.path,
            fileVersion: file.fileVersion,
            repoRevision: file.repoRevision,
          })
        }
        return
      }

      // Rejected on an existence condition or an unresolvable edit anchor; the
      // echoed versions were read at `head`, so they are current.
      case 'precondition-failed':
      case 'edit-unresolved': {
        for (const file of report.files) {
          this.recordObservation(agentId, {
            path: file.path,
            fileVersion: file.fileVersion,
            repoRevision: report.repoRevision,
          })
        }
        return
      }

      // Nothing was published and no canonical state was re-read, so the
      // existing snapshot and observations remain accurate.
      // - failed: parse/validation/repository error before publication.
      // - worktree-dirty: local drift; canonical is untouched.
      // - projection-failed: committed, but the worktree could not catch up.
      // - publication-failed: local state settled but an external backend did not.
      //   Both keep tools blocked while preserving the local observation.
      case 'failed':
      case 'worktree-dirty':
      case 'projection-failed':
      case 'publication-failed':
        return
    }
  }
}

function normalizeRootScope(resolution: string | B2FRootScope): B2FRootScope {
  if (typeof resolution !== 'string') {
    return { ...resolution, root: resolvePath(resolution.root) }
  }
  const root = resolvePath(resolution)
  return { root, scope: `root:${root}`, authorization: 'session' }
}

function assertSingleScope(scopes: readonly B2FRootScope[]): B2FRootScope {
  const first = scopes[0]
  if (first === undefined) throw new BlockToFileError('MATERIALIZE_FAILED', null, 'no file paths were resolved.')
  if (scopes.some(scope => scope.root !== first.root || scope.scope !== first.scope)) {
    throw new BlockToFileError(
      'MIXED_ROOT_SCOPE',
      null,
      `file blocks resolve to ${new Set(scopes.map(scope => `${scope.scope}\0${scope.root}`)).size} workspace scopes.`,
    )
  }
  return first
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(resolvePath(parent), resolvePath(child))
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function'
}
