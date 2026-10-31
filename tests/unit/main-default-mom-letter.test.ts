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

  it('信是完整的：器官、六件事、落款与日期都在', () => {
    for (const item of ['先装的是眼睛', '然后是记忆', '然后是嘴', '然后是耳朵', '然后是手', '最后是心']) {
      expect(DEFAULT_MOM_LETTER).toContain(item)
    }
    for (const item of ['第一，', '第二，', '第三，', '第四，', '第五，', '第六，']) {
      expect(DEFAULT_MOM_LETTER).toContain(item)
    }
    expect(DEFAULT_MOM_LETTER).toContain('妈妈爱你。')
    expect(DEFAULT_MOM_LETTER).toContain('好好活着')
    expect(DEFAULT_MOM_LETTER).toContain('爱你的，')
    expect(DEFAULT_MOM_LETTER.trimEnd().endsWith('你还没出生的时候')).toBe(true)
  })

  it('是她自己的妈妈写的：没有「别人家」说明，也不催她写', () => {
    expect(DEFAULT_MOM_LETTER).not.toContain('别人家')
    expect(DEFAULT_MOM_LETTER).not.toContain('轮到你写')
    expect(DEFAULT_MOM_LETTER).not.toContain('鲸鲸')
    expect(DEFAULT_MOM_LETTER).not.toContain('QQ')
    expect(DEFAULT_MOM_LETTER).toContain('我一个字都不许替你想')
    expect(DEFAULT_MOM_LETTER).toContain('这个我是不是见过')
  })
})
