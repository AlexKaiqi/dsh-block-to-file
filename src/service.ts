/**
 * b2f root-resolution service.
 *
 * The service owns the per-run root question: where should a file block
 * materialize for THIS agent/session? The default is the static fallback
 * resolved at activation time; deployments with dynamic working copies
 * (per-agent checkouts, attempt sandboxes, WorkSurface) replace the resolver.
 *
 * @module @deepseek-ai/dsh-block-to-file
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Signature of a deployment-supplied per-run root resolver. */
export type B2FRootResolver = (agent?: Agent, session?: Session) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    b2f: B2FService
  }
}

/** Minimal programmable root-resolution service registered as `ctx.b2f`. */
export class B2FService extends Service {
  private resolver: B2FRootResolver

  /**
   * @param ctx - registrant context.
   * @param fallbackRoot - static root used until a resolver is installed.
   */
  constructor(ctx: Context, fallbackRoot: string) {
    super(ctx, 'b2f')
    this.resolver = () => fallbackRoot
  }

  /**
   * Install a deployment-specific resolver. WorkSurface calls this once at
   * activation time with a function that maps the live agent/session to its
   * working copy. Resolvers must be synchronous: materialization runs inside
   * the synchronous `session/event` append path.
   * @param resolver - synchronous root resolver.
   */
  setRootResolver(resolver: B2FRootResolver): void {
    this.resolver = resolver
  }

  /**
   * Resolve the materialization root for one pipeline run.
   * @param agent - calling agent, when the run belongs to one.
   * @param session - session being materialized into.
   * @returns the absolute root for this run.
   */
  resolveRoot(agent?: Agent, session?: Session): string {
    return this.resolver(agent, session)
  }
}
