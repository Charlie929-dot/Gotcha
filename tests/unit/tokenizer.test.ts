import { describe, expect, it } from 'vitest'
import {
  BERT_MAX_LENGTH,
  basicTokenize,
  cleanText,
  encodeText,
  loadVocab,
  spaceChinese,
  wordPiece
} from '../../src/understand/embedding/tokenizer'

// 词表行号即 id：0 [PAD] … 3 [SEP]
const VOCAB_TEXT = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '你',
  '好',
  '世',
  '界',
  '，',
  'hello',
  'world',
  '##s',
  '##ing',
  'the',
  '##e',
  'cats',
  'cat'
].join('\n')

const vocab = loadVocab(VOCAB_TEXT)

describe('loadVocab', () => {
  it('行号即 id，特殊符号缺失时才回退默认值', () => {
    expect(vocab.ids.get('你')).toBe(4)
    expect(vocab.padId).toBe(0)
    expect(vocab.unkId).toBe(1)
    expect(vocab.clsId).toBe(2)
    expect(vocab.sepId).toBe(3)

    const partial = loadVocab('a\nb')
    expect(partial.ids.get('b')).toBe(1)
    expect(partial.clsId).toBe(101)
    expect(partial.sepId).toBe(102)
  })
})

describe('cleanText / spaceChinese', () => {
  it('清控制字符、空白归一', () => {
    expect(cleanText('  a\tb\nc  ')).toBe('a b c')
    expect(cleanText('a\u0000b')).toBe('ab')
    expect(cleanText('\u0001')).toBe('')
  })

  it('中文按字拆开，英文/数字保持原样', () => {
    expect(spaceChinese('你好world')).toBe('你 好 world')
    expect(spaceChinese('你，好')).toBe('你 ， 好')
    expect(spaceChinese('a b')).toBe('a b')
  })
})

describe('wordPiece', () => {
  it('贪心最长匹配，非词首带 ##', () => {
    expect(wordPiece('cats', vocab)).toEqual(['cats'])
    expect(wordPiece('cating', vocab)).toEqual(['cat', '##ing'])
    expect(wordPiece('hellos', vocab)).toEqual(['hello', '##s'])
  })

  it('匹配不上整词判 [UNK]；超长词直接 [UNK]', () => {
    expect(wordPiece('zzz', vocab)).toEqual(['[UNK]'])
    expect(wordPiece('x'.repeat(101), vocab)).toEqual(['[UNK]'])
    expect(wordPiece('', vocab)).toEqual([])
  })
})

describe('basicTokenize', () => {
  it('默认不做小写（bge-small-zh 的 do_lower_case=false）', () => {
    expect(basicTokenize('Hello World')).toEqual(['Hello', 'World'])
    expect(basicTokenize('Hello World', { lowercase: true })).toEqual(['hello', 'world'])
  })
})

describe('encodeText', () => {
  it('中文按字切、加 [CLS]/[SEP]', () => {
    const encoded = encodeText('你好世界', vocab)
    expect(encoded.inputIds).toEqual([2, 4, 5, 6, 7, 3])
    expect(encoded.attentionMask).toEqual([1, 1, 1, 1, 1, 1])
    expect(encoded.length).toBe(6)
  })

  it('英文走 WordPiece；未知词进 [UNK]', () => {
    expect(encodeText('hello world', vocab).inputIds).toEqual([2, 9, 10, 3])
    expect(encodeText('zzz', vocab).inputIds).toEqual([2, 1, 3])
  })

  it('空文本只留特殊符号', () => {
    expect(encodeText('   ', vocab).inputIds).toEqual([2, 3])
  })

  it('按 maxLength 截断（含特殊符号）且以 [SEP] 收尾', () => {
    const encoded = encodeText('你好世界你好世界你好世界', vocab, { maxLength: 5 })
    expect(encoded.length).toBe(5)
    expect(encoded.inputIds[0]).toBe(2)
    expect(encoded.inputIds[4]).toBe(3)
    expect(encoded.inputIds.length).toBe(5)
  })

  it('默认上限是 BERT 的 512', () => {
    const longText = '你好'.repeat(400)
    expect(encodeText(longText, vocab).length).toBe(BERT_MAX_LENGTH)
  })
})
