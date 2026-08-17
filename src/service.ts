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

/** Signature of a deployment-supplied per-run root resolver. */
export type B2FRootResolver = (agent?: Agent, session?: Session) => string

export interface B2FCommitConfig {
  readonly canonicalRef: string
  readonly diffLineLimit: number
  readonly tempFileKeep: number
  readonly maxCasRetries: number
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
  private resolver: B2FRootResolver
  private readonly snapshots = new Map<string, AgentSnapshot>()
  private readonly observations = new Map<string, Map<string, FileObservation>>()

  constructor(ctx: Context, fallbackRoot: string) {
    super(ctx, 'b2f')
    this.resolver = (_agent, session) => session?.header.cwd ?? fallbackRoot
  }

  /** Install a generic synchronous resolver for per-agent checkouts or sandboxes. */
  setRootResolver(resolver: B2FRootResolver): void {
    this.resolver = resolver
  }

  /** Resolve the repository worktree root for one pipeline run. */
  resolveRoot(agent?: Agent, session?: Session): string {
    return this.resolver(agent, session)
  }

  /** Capture the canonical repository snapshot visible to the next model step. */
  captureSnapshot(agent: Agent, session: Session, canonicalRef: string, tempFileKeep = 16): string {
    const root = this.resolveRoot(agent, session)
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
  ): B2FReport {
    const root = this.resolveRoot(agent, session)
    let snapshot = this.snapshots.get(agent.id)
    if (snapshot === undefined || snapshot.root !== root) {
      const repoRevision = this.captureSnapshot(agent, session, config.canonicalRef, config.tempFileKeep)
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
    }
    const report = commitFileBlocks(proposals, transactionConfig)
    if (report.status === 'committed' || report.status === 'stale') {
      this.snapshots.set(agent.id, { root, repoRevision: report.repoRevision })
    }
    if (report.status === 'committed') {
      for (const entry of validated) {
        this.recordObservation(agent.id, {
          path: entry.normalizedPath,
          fileVersion: fileVersionAt(root, report.repoRevision, entry.normalizedPath),
          repoRevision: report.repoRevision,
        })
      }
    } else if (report.status === 'stale') {
      for (const file of report.staleFiles) {
        this.recordObservation(agent.id, {
          path: file.path,
          fileVersion: file.fileVersion,
          repoRevision: file.repoRevision,
        })
      }
    }
    return report
  }
}
