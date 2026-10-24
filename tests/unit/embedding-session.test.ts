import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildFeeds,
  clsPoolAndNormalize,
  createLocalEmbedder,
  isModelReady,
  pickHiddenState,
  readModelDim,
  type OrtModuleLike,
  type OrtSessionLike,
  type OrtTensorData,
  type OrtTensorLike
} from '../../src/understand/embedding/session'
import { EmbeddingError } from '../../src/understand/embedding/types'

const VOGUE_VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '你', '好'].join('\n')

const tempDirs: string[] = []
function makeModelDir(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gotcha-embed-'))
  tempDirs.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** 假 ORT：记录每次 run 的 feeds，输出 [batch, seq, 3] 的 last_hidden_state */
function fakeOrt(options: { inputs?: string[]; failOnRun?: boolean } = {}): {
  ort: OrtModuleLike
  runs: Array<Record<string, OrtTensorLike>>
  createCalls: Array<{ path: string; options?: Record<string, unknown> }>
} {
  const runs: Array<Record<string, OrtTensorLike>> = []
  const createCalls: Array<{ path: string; options?: Record<string, unknown> }> = []
  const session: OrtSessionLike = {
    inputNames: options.inputs ?? ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    async run(feeds) {
      runs.push(feeds)
      if (options.failOnRun) throw new Error('ORT 爆炸')
      const inputIds = feeds.input_ids
      const [batch, seq] = inputIds.dims
      const dim = 3
      const data = new Float32Array(batch * seq * dim)
      // 每个序列第 0 位放 (b+1, 0, 0)，其余填噪声以验证只取 CLS
      for (let b = 0; b < batch; b += 1) {
        data[b * seq * dim] = b + 1
        for (let i = 1; i < seq; i += 1) data[(b * seq + i) * dim + 1] = 99
      }
      return {
        last_hidden_state: { data, dims: [batch, seq, dim] }
      }
    }
  }
  const ort: OrtModuleLike = {
    InferenceSession: {
      async create(path, createOptions) {
        createCalls.push({ path, options: createOptions })
        return session
      }
    },
    Tensor: class implements OrtTensorLike {
      data: OrtTensorData
      dims: number[]
      constructor(_type: string, data: OrtTensorData, dims: number[]) {
        this.data = data
        this.dims = dims
      }
    }
  }
  return { ort, runs, createCalls }
}

describe('clsPoolAndNormalize', () => {
  it('取每条序列第 0 位并 L2 归一化，忽略后面的位置', () => {
    const data = new Float32Array([
      // batch 0：[CLS]=(3,4,0)
      3, 4, 0, 0, 0, 0,
      // batch 1：[CLS]=(0,0,2)
      0, 0, 2, 0, 0, 0
    ])
    const vectors = clsPoolAndNormalize(data, [2, 2, 3], 2)
    expect(vectors).toHaveLength(2)
    const first = vectors[0]
    expect(first[0]).toBeCloseTo(0.6)
    expect(first[1]).toBeCloseTo(0.8)
    expect(first[2]).toBeCloseTo(0)
    expect([...vectors[1]]).toEqual([0, 0, 1])
  })

  it('形状不符 / 全零向量安全', () => {
    expect(() => clsPoolAndNormalize(new Float32Array(4), [2, 2], 2)).toThrow(EmbeddingError)
    expect(() => clsPoolAndNormalize(new Float32Array(6), [1, 2, 3], 3)).toThrow(EmbeddingError)
    const zero = clsPoolAndNormalize(new Float32Array([0, 0, 0]), [1, 1, 3], 1)
    expect([...zero[0]]).toEqual([0, 0, 0])
  })
})

describe('buildFeeds / pickHiddenState', () => {
  it('按批补 PAD、attention mask 对应 0，token_type_ids 只在模型需要时给', () => {
    const { ort } = fakeOrt()
    const feeds = buildFeeds(
      ort,
      { inputNames: ['input_ids', 'attention_mask', 'token_type_ids'] },
      [
        { inputIds: [2, 4, 3], attentionMask: [1, 1, 1] },
        { inputIds: [2, 5, 3], attentionMask: [1, 1, 1] }
      ],
      0
    )
    expect(Object.keys(feeds).sort()).toEqual(['attention_mask', 'input_ids', 'token_type_ids'])
    expect(feeds.input_ids.dims).toEqual([2, 3])
    expect([...(feeds.input_ids.data as BigInt64Array)].map(Number)).toEqual([2, 4, 3, 2, 5, 3])
    expect([...(feeds.attention_mask.data as BigInt64Array)].map(Number)).toEqual([1, 1, 1, 1, 1, 1])

    const padded = buildFeeds(ort, { inputNames: ['input_ids'] }, [
      { inputIds: [2, 3], attentionMask: [1, 1] },
      { inputIds: [2, 4, 5, 3], attentionMask: [1, 1, 1, 1] }
    ], 0)
    expect(padded.input_ids.dims).toEqual([2, 4])
    expect([...(padded.input_ids.data as BigInt64Array)].map(Number)).toEqual([2, 3, 0, 0, 2, 4, 5, 3])
    expect([...(padded.attention_mask.data as BigInt64Array)].map(Number)).toEqual([1, 1, 0, 0, 1, 1, 1, 1])
    expect(padded.token_type_ids).toBeUndefined()
  })

  it('优先 last_hidden_state，其次第一个输出', () => {
    const tensor: OrtTensorLike = { data: new Float32Array(2), dims: [1, 1, 2] }
    expect(pickHiddenState({ outputNames: ['pooler'] }, { pooler: tensor })).toBe(tensor)
    expect(pickHiddenState({ outputNames: ['a'] }, { last_hidden_state: tensor })).toBe(tensor)
    expect(pickHiddenState({ outputNames: [] }, {})).toBeNull()
  })
})

describe('createLocalEmbedder', () => {
  it('模型/词表缺失时报明确错误码', async () => {
    const empty = makeModelDir({})
    expect(isModelReady(empty)).toBe(false)
    await expect(createLocalEmbedder({ modelDir: empty })).rejects.toMatchObject({
      code: 'model-missing'
    })

    const modelOnly = makeModelDir({ 'model.onnx': Buffer.from('fake') })
    await expect(createLocalEmbedder({ modelDir: modelOnly })).rejects.toMatchObject({
      code: 'vocab-missing'
    })
  })

  it('加载 config.json 的 hidden_size（缺失回退 512）', () => {
    const withConfig = makeModelDir({ 'config.json': JSON.stringify({ hidden_size: 768 }) })
    expect(readModelDim(withConfig)).toBe(768)
    const bad = makeModelDir({ 'config.json': '{oops' })
    expect(readModelDim(bad)).toBe(512)
    expect(readModelDim(makeModelDir({}))).toBe(512)
  })

  it('按批推理、CLS 池化归一化，并把模型名/维度暴露出来', async () => {
    const dir = makeModelDir({
      'model.onnx': Buffer.from('fake'),
      'vocab.txt': VOGUE_VOCAB,
      'config.json': JSON.stringify({ hidden_size: 3 })
    })
    const { ort, runs, createCalls } = fakeOrt()
    const embedder = await createLocalEmbedder({
      modelDir: dir,
      batchSize: 1,
      loadOrt: async () => ort
    })

    expect(embedder.model).toBe('bge-small-zh-v1.5')
    expect(embedder.dim).toBe(3)
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0].path).toBe(join(dir, 'model.onnx'))
    expect(createCalls[0].options).toMatchObject({ intraOpNumThreads: 1 })

    const vectors = await embedder.embed(['你好', '好'])
    expect(runs).toHaveLength(2) // batchSize=1
    expect(vectors.map((vector) => [...vector])).toEqual([
      [1, 0, 0],
      [1, 0, 0]
    ])
    // 词表映射：[CLS] 2、你 4、好 5、[SEP] 3
    expect([...(runs[0].input_ids.data as BigInt64Array)].map(Number)).toEqual([2, 4, 5, 3])
    expect(await embedder.embed([])).toEqual([])
  })

  it('推理失败包成 run-failed', async () => {
    const dir = makeModelDir({
      'model.onnx': Buffer.from('fake'),
      'vocab.txt': VOGUE_VOCAB
    })
    const { ort } = fakeOrt({ failOnRun: true })
    const embedder = await createLocalEmbedder({ modelDir: dir, loadOrt: async () => ort })
    await expect(embedder.embed(['你好'])).rejects.toMatchObject({ code: 'run-failed' })
  })
})
