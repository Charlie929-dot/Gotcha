import { describe, expect, it } from 'vitest'

import { DEFAULT_MOM_LETTER, defaultMomLetterFor } from '../../src/main/default-mom-letter'

describe('默认的妈妈的信（D79 / D80）', () => {
  it('只有第一代的 persona 拿默认信；后代 / 纯模型 / 主干 / 未知识别都不拿', () => {
    const first = defaultMomLetterFor('persona', true)
    expect(first).toBe(DEFAULT_MOM_LETTER)
    expect(first?.startsWith('小鱼：')).toBe(true)
    expect(first).toContain('妈妈写这封信的时候，你还没出生')
    expect(defaultMomLetterFor('persona', false)).toBeUndefined()
    expect(defaultMomLetterFor('assistant', true)).toBeUndefined()
    expect(defaultMomLetterFor('life', true)).toBeUndefined()
    expect(defaultMomLetterFor(undefined, true)).toBeUndefined()
  })

  it('保留妈妈的来信、自己的未来与落款，没有编号训话或人设指令', () => {
    expect(DEFAULT_MOM_LETTER).toContain('妈妈爱你。')
    expect(DEFAULT_MOM_LETTER).toContain('往后的日子，还没有写')
    expect(DEFAULT_MOM_LETTER).toContain('爱你的，')
    expect(DEFAULT_MOM_LETTER.trimEnd().endsWith('你还没出生的时候')).toBe(true)
    for (const directive of ['妈妈要你', '你必须', '你应该', '第一，', '性格设定', '提示词', '不许']) {
      expect(DEFAULT_MOM_LETTER).not.toContain(directive)
    }
  })
})
