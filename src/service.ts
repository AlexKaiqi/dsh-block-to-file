/**
 * Standalone observation and transaction service for block-to-file.
 *
 * The service owns agent snapshots and explicit path observations. A dynamic
 * root resolver is a generic checkout/sandbox facility; no downstream plugin
 * participates in b2f's Git concurrency semantics.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { commitFileBlocks, fileVersionAt, projectRevision, resolveCanonicalRevision, resolveWorktreeRevision } from './transaction.ts'
import type { TransactionConfig } from './transaction.ts'
import type { B2FReport, FileObservation } from './types.ts'
import type { ValidatedFileBlock } from './validator.ts'

/** Signature of a deployment-supplied path-aware root resolver. */
export type B2FRootResolver = (
  agent?: Agent,
  session?: Session,
  paths?: readonly string[],
) => string | undefined

export interface B2FCommitConfig {
  readonly canonicalRef: string
  readonly diffLineLimit: number
  readonly tempFileKeep: number
  readonly maxCasRetries: number
  readonly maxEditDrift: number
}

interface AgentSnapshot {
  readonly root: string
  readonly repoRevision: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    b2f: B2FService
  }
}

/** Standalone b2f service registered as `ctx.b2f`. */
export class B2FService extends Service {
  private readonly fallbackResolver: (agent?: Agent, session?: Session) => string
  private readonly resolvers: Array<{ readonly resolve: B2FRootResolver }> = []
  private readonly snapshots = new Map<string, AgentSnapshot>()
  private readonly observations = new Map<string, Map<string, FileObservation>>()

  constructor(ctx: Context, fallbackRoot: string) {
    super(ctx, 'b2f')
    this.fallbackResolver = (_agent, session) => session?.header.cwd ?? fallbackRoot
    ctx.on('agent/disposed', ({ agent }) => {
      this.releaseAgent(String(agent.id))
    })
  }

  /**
   * Register a synchronous resolver for per-agent checkouts or sandboxes.
   *
   * The newest live registration wins. The returned disposer removes exactly
   * this registration, so independently mounted consumers unwind correctly.
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

  /** Resolve the repository worktree root for one pipeline run. */
  resolveRoot(agent?: Agent, session?: Session, paths?: readonly string[]): string {
    for (let index = this.resolvers.length - 1; index >= 0; index -= 1) {
      const root = this.resolvers[index]?.resolve(agent, session, paths)
      if (root !== undefined) return root
    }
    return this.fallbackResolver(agent, session)
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
      // - projection-failed: committed, but the worktree could not catch up;
      //   tools stay blocked and the next step re-prepares the view.
      case 'failed':
      case 'worktree-dirty':
      case 'projection-failed':
        return
    }
  }
}
