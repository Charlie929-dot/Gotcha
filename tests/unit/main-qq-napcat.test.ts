/**
 * QQ 通道 · NapCat 托管（D66）
 *
 * 这里只测能脱离真机跑的部分：
 * - 目录探测 / 必需文件校验；
 * - OneBot 反向 WS 配置合并（不动别的客户端、重名只留一条、没变就不重连）；
 * - WebUI 配置解析与登录 hash；
 * - 二维码 PNG → data URL；
 * - 托管器的几条早退路径（没 token / 已经连着）。
 *
 * 真正的「拉起 QQ + 扫码」属于真机验收，不在单测里跑。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  findNapcatDir,
  isNapcatDir,
  mergeOneBotConfig,
  NAPCAT_REQUIRED_FILES,
  napcatTokenHash,
  NapcatManager,
  parseWebuiConfig,
  qrcodeDataUrl,
  type NapcatDeps
} from '../../src/main/qq/napcat'

const tempDirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gotcha-napcat-'))
  tempDirs.push(dir)
  return dir
}

/** 造一个「看起来像 NapCat Shell」的目录 */
async function makeShell(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  for (const name of NAPCAT_REQUIRED_FILES) {
    await writeFile(join(dir, name), '', 'utf8')
  }
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function deps(overrides: Partial<NapcatDeps> = {}): NapcatDeps {
  return {
    userDataDir: 'C:\\Users\\test\\AppData\\Roaming\\Gotcha',
    getEndpoint: () => ({ port: 8643, token: 'test-token-1234' }),
    isConnected: () => false,
    getAutoStart: () => true,
    getShellDir: () => '',
    setShellDir: () => undefined,
    log: () => undefined,
    ...overrides
  }
}

describe('NapCat 目录', () => {
  it('必需文件齐了才算可用', async () => {
    const root = await makeDir()
    const shell = await makeShell(join(root, 'NapCat.Shell'))
    expect(await isNapcatDir(shell)).toBe(true)
    expect(await isNapcatDir(join(root, 'nope'))).toBe(false)
  })

  it('能在 OneKey 两层目录里找到 Shell', async () => {
    const userData = await makeDir()
    await makeShell(join(userData, 'napcat', 'OneKey', 'NapCat.52230.Shell'))
    const found = await findNapcatDir('', userData, { LOCALAPPDATA: '', USERPROFILE: '' })
    expect(found).toBe(join(userData, 'napcat', 'OneKey', 'NapCat.52230.Shell'))
  })

  it('手选目录优先', async () => {
    const userData = await makeDir()
    const manual = await makeShell(join(userData, 'manual-shell'))
    await makeShell(join(userData, 'napcat', 'NapCat.Shell'))
    const found = await findNapcatDir(manual, userData, { LOCALAPPDATA: '', USERPROFILE: '' })
    expect(found).toBe(manual)
  })

  it('手选目录无效时继续自动探测', async () => {
    const userData = await makeDir()
    const auto = await makeShell(join(userData, 'napcat', 'NapCat.Shell'))
    const found = await findNapcatDir('C:\\definitely-not-there', userData, {
      LOCALAPPDATA: '',
      USERPROFILE: ''
    })
    expect(found).toBe(auto)
  })
})

describe('OneBot 配置合并', () => {
  const endpoint = { port: 8643, token: 'token-1234' }

  it('没有 gotcha 客户端就追加，其它服务原样保留', () => {
    const raw = {
      network: {
        websocketServers: [{ name: 'mine', enable: true, port: 3001 }],
        websocketClients: [{ name: 'other', enable: true, url: 'ws://example.test' }]
      },
      musicSignUrl: ''
    }
    const merged = mergeOneBotConfig(raw, endpoint)
    expect(merged.changed).toBe(true)
    const network = merged.config['network'] as Record<string, unknown>
    const clients = network['websocketClients'] as Array<Record<string, unknown>>
    expect(clients).toHaveLength(2)
    expect(clients[0]?.['name']).toBe('other')
    expect(clients[1]).toMatchObject({
      name: 'gotcha',
      enable: true,
      url: 'ws://127.0.0.1:8643',
      token: 'token-1234',
      messagePostFormat: 'array'
    })
    expect(network['websocketServers']).toEqual([{ name: 'mine', enable: true, port: 3001 }])
  })

  it('已有的 gotcha 客户端就原位更新（不重名、不重复）', () => {
    const raw = {
      network: {
        websocketClients: [
          { name: 'gotcha', enable: false, url: 'ws://127.0.0.1:1111', token: 'old-token' },
          { name: 'gotcha', enable: true, url: 'ws://127.0.0.1:2222', token: 'dupe' }
        ]
      }
    }
    const merged = mergeOneBotConfig(raw, endpoint)
    expect(merged.changed).toBe(true)
    const clients = (merged.config['network'] as Record<string, unknown>)[
      'websocketClients'
    ] as Array<Record<string, unknown>>
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ name: 'gotcha', enable: true, url: 'ws://127.0.0.1:8643' })
  })

  it('已经在目标状态时 changed=false（不白重连）', () => {
    const raw = {
      network: {
        websocketClients: [
          {
            name: 'gotcha',
            enable: true,
            url: 'ws://127.0.0.1:8643',
            reportSelfMessage: false,
            messagePostFormat: 'array',
            token: 'token-1234',
            debug: false,
            heartInterval: 30_000,
            reconnectInterval: 3_000
          }
        ]
      }
    }
    expect(mergeOneBotConfig(raw, endpoint).changed).toBe(false)
  })

  it('空配置也能长出 network.websocketClients', () => {
    const merged = mergeOneBotConfig({}, endpoint)
    expect(merged.changed).toBe(true)
    const network = merged.config['network'] as Record<string, unknown>
    expect(Array.isArray(network['websocketClients'])).toBe(true)
  })
})

describe('WebUI 配置', () => {
  it('解析端口与 token', () => {
    expect(parseWebuiConfig(JSON.stringify({ host: '::', port: 6099, token: ' abc ' }))).toEqual({
      port: 6099,
      token: 'abc'
    })
  })

  it('缺 token / 端口不合法返回 null', () => {
    expect(parseWebuiConfig(JSON.stringify({ port: 6099, token: '' }))).toBeNull()
    expect(parseWebuiConfig(JSON.stringify({ port: 0, token: 'abc' }))).toBeNull()
    expect(parseWebuiConfig('not json')).toBeNull()
  })

  it('登录 hash 是 sha256(token + ".napcat")', () => {
    expect(napcatTokenHash('abc')).toBe(
      '42e5515d256cb0ab3de18017ee3adefc15aa70229c27788bab5aee39d5d439e6'
    )
  })
})

describe('二维码', () => {
  it('PNG 头 → data URL', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const url = qrcodeDataUrl(png)
    expect(url).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(url!.split(',')[1] ?? '', 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    )
  })

  it('不是 PNG 就返回 null', () => {
    expect(qrcodeDataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
    expect(qrcodeDataUrl(new Uint8Array([0x89, 0x50]))).toBeNull()
  })
})

describe('NapcatManager 早退路径', () => {
  it('没填 token 不启动（给出可读原因）', async () => {
    const manager = new NapcatManager(
      deps({ getEndpoint: () => ({ port: 8643, token: 'short' }) })
    )
    const result = await manager.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('access_token')
    expect(manager.status().loggedIn).toBe(false)
  })

  it('已经连着就直接标 connected，不再拉进程', async () => {
    const manager = new NapcatManager(deps({ isConnected: () => true }))
    const result = await manager.start()
    expect(result.ok).toBe(true)
    expect(manager.status().phase).toBe('connected')
    expect(manager.status().loggedIn).toBe(true)
  })

  it('选目录时校验必需文件', async () => {
    const root = await makeDir()
    const shell = await makeShell(join(root, 'shell'))
    let saved = ''

    const manager = new NapcatManager(deps({ setShellDir: (dir) => (saved = dir) }))
    expect((await manager.setShellDir(join(root, 'nope'))).ok).toBe(false)
    expect(saved).toBe('')

    const result = await manager.setShellDir(shell)
    expect(result.ok).toBe(true)
    expect(saved).toBe(shell)
  })
})
