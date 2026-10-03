import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { patchSchema } from '../src/lib/validate'
import { UpdateCampaignBody } from '../src/modules/campaigns/campaigns.schemas'

describe('patchSchema', () => {
  it('does not apply defaults to omitted fields (regression: partial() reset values on update)', () => {
    const schema = z.object({ name: z.string(), payout: z.string().default('0'), active: z.boolean().default(true) })
    expect(patchSchema(schema).parse({ name: 'x' })).toEqual({ name: 'x' })
  })

  it('keeps field validation', () => {
    const schema = z.object({ email: z.string().email().default('a@b.co') })
    expect(() => patchSchema(schema).parse({ email: 'nope' })).toThrow()
  })

  it('leaves campaign rates untouched when only the description changes', () => {
    expect(UpdateCampaignBody.parse({ description: 'new' })).toEqual({ description: 'new' })
  })
})
