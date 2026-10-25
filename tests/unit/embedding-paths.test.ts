/**
 * 本地向量模型的目录查找（D37：模型随应用分发，不再要求手工放置）
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  EMBEDDING_MODEL_DIR_NAME,
  defaultEmbeddingModelDir,
  embeddingModelCandidates,
  pickEmbeddingModelDir,
  resolveEmbeddingModelDir
} from '../../src/understand/embedding/paths'

const USER_DATA = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Gotcha')
const APP_PATH = join('D:', 'Gotcha')
const RESOURCES = join('D:', 'Program Files', 'Gotcha', 'resources')

describe('embeddingModelCandidates', () => {
  it('设了覆盖就只用它（权威，不回退到自带模型）', () => {
    expect(
      embeddingModelCandidates({
        setting: join('E:', 'my-model'),
        resourcesPath: RESOURCES,
        appPath: APP_PATH,
        userDataDir: USER_DATA
      })
    ).toEqual([join('E:', 'my-model')])
  })

  it('没设覆盖：打包资源 → 仓库 resources → userData 历史位置', () => {
    const candidates = embeddingModelCandidates({
      setting: '   ',
      resourcesPath: RESOURCES,
      appPath: APP_PATH,
      userDataDir: USER_DATA
    })
    expect(candidates).toEqual([
      join(RESOURCES, 'models', EMBEDDING_MODEL_DIR_NAME),
      join(APP_PATH, 'resources', 'models', EMBEDDING_MODEL_DIR_NAME),
      defaultEmbeddingModelDir(USER_DATA)
    ])
  })

  it('没有 resourcesPath 时只留仓库与 userData（dev 下直接用自带模型）', () => {
    const candidates = embeddingModelCandidates({
      setting: null,
      resourcesPath: null,
      appPath: APP_PATH,
      userDataDir: USER_DATA
    })
    expect(candidates).toEqual([
      join(APP_PATH, 'resources', 'models', EMBEDDING_MODEL_DIR_NAME),
      defaultEmbeddingModelDir(USER_DATA)
    ])
  })

  it('打包后 resourcesPath 与 appPath 重叠时目录只留一次', () => {
    const same = join('D:', 'app')
    const candidates = embeddingModelCandidates({
      setting: '',
      resourcesPath: same,
      appPath: same,
      userDataDir: USER_DATA
    })
    expect(new Set(candidates).size).toBe(candidates.length)
  })
})

describe('pickEmbeddingModelDir', () => {
  const candidates = ['a', 'b', 'c']

  it('选第一个就绪的候选', () => {
    expect(pickEmbeddingModelDir(candidates, (dir) => dir === 'b')).toBe('b')
    expect(pickEmbeddingModelDir(candidates, () => true)).toBe('a')
  })

  it('都不就绪时返回第一个候选（报错/日志指向最该放的位置）', () => {
    expect(pickEmbeddingModelDir(candidates, () => false)).toBe('a')
    expect(pickEmbeddingModelDir([], () => true)).toBe('')
  })
})

describe('resolveEmbeddingModelDir（兼容旧调用）', () => {
  it('设置非空用设置，否则回退 userData 默认目录', () => {
    expect(resolveEmbeddingModelDir(USER_DATA, 'E:/model')).toBe('E:/model')
    expect(resolveEmbeddingModelDir(USER_DATA, '')).toBe(defaultEmbeddingModelDir(USER_DATA))
    expect(resolveEmbeddingModelDir(USER_DATA, null)).toBe(defaultEmbeddingModelDir(USER_DATA))
  })
})
