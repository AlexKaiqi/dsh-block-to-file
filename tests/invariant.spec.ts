import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import * as BlockToFileInvariant from '../src/invariant.ts'

describe('block-to-file invariant companion', () => {
  it('reserves package ownership through the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const register = vi.spyOn(ctx.invariants, 'register')

    const fiber = await ctx.plugin(BlockToFileInvariant)

    expect(register).toHaveBeenCalledWith(
      'dsh-block-to-file',
      expect.any(Function),
    )
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
