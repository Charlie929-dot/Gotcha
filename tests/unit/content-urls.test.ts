import { describe, expect, it } from 'vitest'
import {
  CONTENT_URLS_MAX,
  collectUrls,
  contentUrlsOf,
  decodeContentUrls,
  encodeContentUrls
} from '../../src/chain/content/urls'

describe('content-urls', () => {
  it('抽 http(s) 链接：去尾标点、跨行去重、保持出现顺序', () => {
    const urls = collectUrls([
      '地址栏 https://example.com/a/b。',
      '页面里 http://foo.test/x，再一个 https://example.com/a/b'
    ])
    expect(urls).toEqual(['https://example.com/a/b', 'http://foo.test/x'])
  })

  it('太短 / 太长的都丢掉（http://a、超长 base64 串）', () => {
    const long = 'https://example.com/' + 'x'.repeat(500)
    const urls = collectUrls([`http://a https://ok.test/path ${long}`])
    expect(urls).toEqual(['https://ok.test/path'])
  })

  it('最多 3 条（跨行合计），中文括号与引号是边界', () => {
    const urls = collectUrls([
      '（https://a.test/1）"https://b.test/2" https://c.test/3 https://d.test/4'
    ])
    expect(urls).toHaveLength(CONTENT_URLS_MAX)
    expect(urls).toEqual(['https://a.test/1', 'https://b.test/2', 'https://c.test/3'])
  })

  it('存库形态：JSON 数组，读回坏 JSON / 非字符串项一律丢弃', () => {
    expect(contentUrlsOf('没有链接')).toBe('[]')
    expect(decodeContentUrls(contentUrlsOf('看 https://x.test/abc 这个'))).toEqual([
      'https://x.test/abc'
    ])
    expect(decodeContentUrls(null)).toEqual([])
    expect(decodeContentUrls('not json')).toEqual([])
    expect(decodeContentUrls('{"a":1}')).toEqual([])
    expect(decodeContentUrls('["https://a.test/1", 3, ""]')).toEqual(['https://a.test/1'])
  })

  it('encode 会截到上限，避免迁移/写入塞进超量数据', () => {
    const many = ['https://a.test/1', 'https://b.test/2', 'https://c.test/3', 'https://d.test/4']
    expect(decodeContentUrls(encodeContentUrls(many))).toHaveLength(CONTENT_URLS_MAX)
  })
})
