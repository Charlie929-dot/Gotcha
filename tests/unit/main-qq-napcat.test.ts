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

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  findNapcatDir,
  isNapcatDir,
  mergeOneBotConfig,
  NAPCAT_QR_MAX_AGE_MS,
  NAPCAT_REQUIRED_FILES,
  NAPCAT_WEBUI_GRACE_MS,
  napcatTokenHash,
  NapcatManager,
  parseQqRuntimeVersion,
  parseWebuiConfig,
  qrcodeDataUrl,
  qrExpired,
  shellKnowsQqVersion,
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

  it('过期判定：票约 2 分钟，超过就该换一张（没有码也算过期）', () => {
    const now = 1_000_000
    expect(qrExpired(null, now)).toBe(true)
    expect(qrExpired(now - 5_000, now)).toBe(false)
    expect(qrExpired(now - NAPCAT_QR_MAX_AGE_MS + 1, now)).toBe(false)
    expect(qrExpired(now - NAPCAT_QR_MAX_AGE_MS - 1, now)).toBe(true)
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

describe('NapcatManager 启动前的 QQ / 僵尸进程判断（2026-11-04 真机）', () => {
  async function managerWithShell(overrides: Partial<NapcatDeps> = {}): Promise<{
    manager: NapcatManager
    spawnImpl: ReturnType<typeof vi.fn>
  }> {
    const root = await makeDir()
    const shell = await makeShell(join(root, 'shell'))
    const child = { pid: 4321, unref: (): void => {}, on: (): unknown => child }
    const spawnImpl = vi.fn(() => child)
    const manager = new NapcatManager(
      deps({
        getShellDir: () => shell,
        resolveQqPath: async () => 'C:\\Program Files\\QQ.exe',
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
        spawnImpl: spawnImpl as unknown as NapcatDeps['spawnImpl'],
        ...overrides
      })
    )
    return { manager, spawnImpl }
  }

  it('QQ 已经在运行：不 spawn（拉不起来，只会留僵尸），报可读原因', async () => {
    const { manager, spawnImpl } = await managerWithShell({
      isBootmainRunning: async () => false,
      isQqRunning: async () => true
    })
    const result = await manager.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('先退出 QQ')
    expect(spawnImpl).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('bootmain 在跑但 QQ 没起来：判定为上次失败的僵尸，不接管、不 spawn', async () => {
    const { manager, spawnImpl } = await managerWithShell({
      isBootmainRunning: async () => true,
      isQqRunning: async () => false
    })
    const result = await manager.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('QQ 没起来')
    expect(spawnImpl).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('bootmain 在跑且 QQ 也在跑：接管轮询（手动开的 NapCat 照常可用）', async () => {
    const { manager, spawnImpl } = await managerWithShell({
      isBootmainRunning: async () => true,
      isQqRunning: async () => true
    })
    const result = await manager.start()
    expect(result.ok).toBe(true)
    expect(manager.status().phase).toBe('waiting-login')
    expect(spawnImpl).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('QQ 没跑、也没有 bootmain：正常 spawn 一次', async () => {
    const { manager, spawnImpl } = await managerWithShell({
      isBootmainRunning: async () => false,
      isQqRunning: async () => false
    })
    const result = await manager.start()
    expect(result.ok).toBe(true)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    manager.dispose()
  })
})

describe('QQ 版本适配检查（2026-11-08）', () => {
  it('从 QQ 的 versions/config.json 读运行版本', () => {
    expect(parseQqRuntimeVersion('{"curVersion":"9.9.36-53644"}')).toBe('9.9.36-53644')
    expect(parseQqRuntimeVersion('{"curVersion":"latest"}')).toBeNull()
    expect(parseQqRuntimeVersion('{"curVersion":123}')).toBeNull()
    expect(parseQqRuntimeVersion('not json')).toBeNull()
  })

  it('NapCat 适配表按 <版本>-x64 / -arm64 建键', () => {
    const script = '{"9.9.36-53644-x64":{"send":"C3EE2F"},"9.9.36-53644-arm64":{}}'
    expect(shellKnowsQqVersion(script, '9.9.36-53644')).toBe(true)
    expect(shellKnowsQqVersion(script, '9.9.37-54001')).toBe(false)
  })
})

describe('NapcatManager 掉线自愈 / 提醒（2026-11-04 真机）', () => {
  /** 造带 WebUI 配置和一张二维码的 Shell 目录 */
  async function makeShellWithWebui(root: string): Promise<string> {
    const shell = await makeShell(join(root, 'shell'))
    await mkdir(join(shell, 'config'), { recursive: true })
    await writeFile(
      join(shell, 'config', 'webui.json'),
      JSON.stringify({ host: '::', port: 6099, token: 'webui-token' }),
      'utf8'
    )
    await mkdir(join(shell, 'cache'), { recursive: true })
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
    await writeFile(join(shell, 'cache', 'qrcode.png'), png)
    return shell
  }

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  /** 直接驱动一轮轮询：停掉自动定时器后手动跑，免得每个用例真等 1.5s */
  function pollOnce(manager: NapcatManager): Promise<void> {
    return (manager as unknown as { poll: () => Promise<void> }).poll()
  }

  /** 等 start() 顺手触发的那次 poll 跑完：否则手动 poll 会被 `polling` 标志直接挡掉（负载高时会偶发） */
  async function settlePolling(manager: NapcatManager): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(manager as unknown as { polling: boolean }).polling) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  async function attachedManager(options: {
    clock: () => number
    fetchImpl: typeof fetch
    isConnected?: () => boolean
    notify?: (title: string, content: string) => void
    logs?: string[]
  }): Promise<NapcatManager> {
    const root = await makeDir()
    const shell = await makeShellWithWebui(root)
    const manager = new NapcatManager(
      deps({
        now: options.clock,
        getShellDir: () => shell,
        isBootmainRunning: async () => true,
        isQqRunning: async () => true,
        fetchImpl: options.fetchImpl,
        ...(options.isConnected !== undefined ? { isConnected: options.isConnected } : {}),
        ...(options.notify !== undefined ? { notify: options.notify } : {}),
        log: (_level, message) => options.logs?.push(message)
      })
    )
    const result = await manager.start()
    expect(result.ok).toBe(true)
    manager.dispose() // 只停自动轮询；下面手动驱动
    await new Promise((resolve) => setTimeout(resolve, 30))
    return manager
  }

  it('WebUI 暂时连不上：只报原因不停轮询，恢复后自己收回错误', async () => {
    let clock = Date.now()
    const logs: string[] = []
    let webuiUp = false
    let loggedIn = false
    const fetchImpl = (async (input: unknown) => {
      if (!webuiUp) throw new TypeError('fetch failed')
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: loggedIn } })
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({ clock: () => clock, fetchImpl, logs })

    await pollOnce(manager)
    expect(manager.status().phase).toBe('waiting-login')
    expect(manager.status().error).toBeUndefined()

    // 宽限期过了还连不上：报一次可读原因（旧逻辑这时候已经永久停表）
    clock += NAPCAT_WEBUI_GRACE_MS + 1_000
    await pollOnce(manager)
    expect(manager.status().phase).toBe('error')
    expect(manager.status().error).toContain('后台重试')

    // 还在轮询：同一轮错误不重复刷日志（不停表才会继续走到这里）
    const failures = logs.filter((message) => message === 'napcat failed').length
    clock += 5_000
    await pollOnce(manager)
    expect(logs.filter((message) => message === 'napcat failed').length).toBe(failures)

    // WebUI 回来了（NapCat 重启会换凭据）：自己接回来，错误收掉
    webuiUp = true
    await pollOnce(manager)
    expect(manager.status().phase).toBe('waiting-login')
    expect(manager.status().error).toBeUndefined()
    expect(logs).toContain('napcat webui recovered')

    // 账号其实还登录着：掉线期间的时长不能沿用，别在刚恢复时就把「连不上」判出来
    loggedIn = true
    await pollOnce(manager)
    expect(manager.status().error).toBeUndefined()
  })

  it('WebUI 凭据过期：当轮重登并重试，不把整轮废成 poll failed（2026-11-08 真机）', async () => {
    const clock = (): number => Date.now()
    const logs: string[] = []
    let loginCalls = 0
    let statusCalls = 0
    let currentCredential = ''
    const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) {
        loginCalls += 1
        currentCredential = `cred-${loginCalls}`
        return jsonResponse({ code: 0, data: { Credential: currentCredential } })
      }
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) {
        statusCalls += 1
        const auth = init?.headers?.['authorization'] ?? ''
        if (auth !== `Bearer ${currentCredential}`) {
          return jsonResponse({ code: -1, message: 'Unauthorized', data: null })
        }
        return jsonResponse({ code: 0, data: { isLogin: false } })
      }
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({ clock, fetchImpl, logs })
    await settlePolling(manager)
    const loginsBefore = loginCalls
    const statusesBefore = statusCalls
    const failuresBefore = logs.filter((message) => message === 'napcat poll failed').length

    // NapCat 换了 WebUI 凭据：Gotcha 手里那张旧的立刻失效
    currentCredential = 'cred-rotated'
    await pollOnce(manager)

    // 旧逻辑这一轮直接抛 Unauthorized，要等下一轮 poll 才重登（每小时一条 poll failed）
    expect(loginCalls).toBe(loginsBefore + 1)
    expect(statusCalls).toBe(statusesBefore + 2)
    expect(logs.filter((message) => message === 'napcat poll failed')).toHaveLength(failuresBefore)
  })

  it('本来在线又掉了：弹一次掉线提醒，不重复弹', async () => {
    const clock = (): number => Date.now()
    const notify = vi.fn()
    let connected = false
    let loggedIn = true
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: loggedIn } })
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({
      clock,
      fetchImpl,
      isConnected: () => connected,
      notify
    })

    connected = true
    await pollOnce(manager)
    expect(manager.status().phase).toBe('connected')
    expect(notify).not.toHaveBeenCalled()

    // QQ 账号掉线：NapCat 回到扫码页
    connected = false
    loggedIn = false
    await pollOnce(manager)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('QQ 掉线了', '去「设置 → QQ 通道」扫一下码就能接上')

    await pollOnce(manager)
    expect(notify).toHaveBeenCalledTimes(1)

    // 重新登录并连上后，下一轮掉线还要能提醒
    connected = true
    loggedIn = true
    await pollOnce(manager)
    expect(manager.status().phase).toBe('connected')
    connected = false
    loggedIn = false
    await pollOnce(manager)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('从没连过就不弹提醒（首次扫码不算掉线）', async () => {
    const clock = (): number => Date.now()
    const notify = vi.fn()
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: false } })
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({ clock, fetchImpl, notify })
    await pollOnce(manager)
    expect(notify).not.toHaveBeenCalled()
  })

  it('二维码一直生不出来：退避重试、不刷日志，最后收口成一条可读错误（2026-11-06）', async () => {
    // 时钟往后拨一小时：Shell 里那张旧码就过期了，轮询才会去要新码
    let clock = Date.now() + 3_600_000
    const logs: string[] = []
    let refreshCalls = 0
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: false } })
      if (url.endsWith('/api/QQLogin/RefreshQRcode')) {
        refreshCalls += 1
        throw new Error('TimeoutError')
      }
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({ clock: () => clock, fetchImpl, logs })
    await settlePolling(manager)

    // 第 1 次失败 → 退避 15s；紧接着再轮询不该再打接口
    await pollOnce(manager)
    expect(refreshCalls).toBe(1)
    await pollOnce(manager)
    expect(refreshCalls).toBe(1)

    // 按退避表递进（15 / 30 / 60 / 120），到第 5 次判定卡死
    for (const wait of [15_000, 30_000, 60_000, 120_000]) {
      clock += wait
      await pollOnce(manager)
    }
    expect(refreshCalls).toBe(5)
    expect(manager.status().phase).toBe('error')
    expect(manager.status().error).toContain('停止')
    expect(manager.status().error).toContain('启动')

    // 5 次失败只留 2 条日志（第一次 + 判定卡死那次），不再是每 15 秒一条
    expect(logs.filter((message) => message === 'napcat qrcode refresh failed')).toHaveLength(2)

    // 再轮询也不重复报错、不重复打接口
    clock += 300_000
    const callsBefore = refreshCalls
    await pollOnce(manager)
    expect(refreshCalls).toBeLessThanOrEqual(callsBefore + 1)
  })

  it('二维码卡死的提示不会被 WebUI 自愈顺手收掉（2026-11-07 真机）', async () => {
    // 真机：23:24:15 判定卡死写了错误，0.5 秒后「napcat webui recovered」把它清掉，
    // 抽屉永远停在「等待二维码…」，人只能干等。这里锁住：WebUI 正常也得保留提示。
    let clock = Date.now() + 3_600_000
    let loggedIn = false
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: loggedIn } })
      if (url.endsWith('/api/QQLogin/RefreshQRcode')) throw new Error('TimeoutError')
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = await attachedManager({ clock: () => clock, fetchImpl })
    await settlePolling(manager)
    await pollOnce(manager)
    for (const wait of [15_000, 30_000, 60_000, 120_000]) {
      clock += wait
      await pollOnce(manager)
    }
    const stuck = manager.status().error ?? ''
    expect(manager.status().phase).toBe('error')
    expect(stuck).toContain('停止')

    // WebUI 一直是好的：下一轮不能把这条错误自愈掉
    clock += 300_000
    await pollOnce(manager)
    expect(manager.status().phase).toBe('error')
    expect(manager.status().error).toBe(stuck)

    // 真的登录成功了，才算这条链缓过来
    loggedIn = true
    await pollOnce(manager)
    expect(manager.status().error).toBeUndefined()
  })

  it('QQ 比 NapCat 新：启动时记一条 warn，卡死时把版本带进错误里（2026-11-08）', async () => {
    const root = await makeDir()
    const shell = await makeShellWithWebui(root)
    // 适配表按真实 napcat.mjs 的键格式造：只认 9.9.36-53644
    await writeFile(join(shell, 'napcat.mjs'), '{"9.9.36-53644-x64":{"send":"C3EE2F"}}', 'utf8')
    await mkdir(join(root, 'qq', 'versions'), { recursive: true })
    await writeFile(join(root, 'qq', 'QQ.exe'), '', 'utf8')
    await writeFile(join(root, 'qq', 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.99-99999' }), 'utf8')

    let clock = Date.now() + 3_600_000
    const logs: string[] = []
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: false } })
      if (url.endsWith('/api/QQLogin/RefreshQRcode')) throw new Error('TimeoutError')
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = new NapcatManager(
      deps({
        userDataDir: root,
        now: () => clock,
        getShellDir: () => shell,
        resolveQqPath: async () => join(root, 'qq', 'QQ.exe'),
        isBootmainRunning: async () => true,
        isQqRunning: async () => true,
        fetchImpl,
        log: (_level, message) => logs.push(message)
      })
    )
    await manager.start()
    expect(logs).toContain('napcat qq version unsupported')
    manager.dispose()
    await settlePolling(manager)

    await pollOnce(manager)
    for (const wait of [15_000, 30_000, 60_000, 120_000]) {
      clock += wait
      await pollOnce(manager)
    }
    expect(manager.status().error).toContain('9.9.99-99999')
    expect(manager.status().error).toContain('NapCat Shell')
  })

  it('登录过的 uin 会记下来，下次拉起时带上走快速登录', async () => {
    const clock = (): number => Date.now()
    const root = await makeDir()
    const shell = await makeShellWithWebui(root)
    const fetchImpl = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/api/auth/login')) return jsonResponse({ code: 0, data: { Credential: 'cred-1' } })
      if (url.endsWith('/api/QQLogin/CheckLoginStatus')) return jsonResponse({ code: 0, data: { isLogin: true } })
      if (url.endsWith('/api/QQLogin/GetQQLoginInfo')) {
        return jsonResponse({ code: 0, data: { uin: '2876349587', online: true } })
      }
      return jsonResponse({ code: 0, data: {} })
    }) as unknown as typeof fetch

    const manager = new NapcatManager(
      deps({
        userDataDir: root,
        now: clock,
        getShellDir: () => shell,
        isBootmainRunning: async () => true,
        isQqRunning: async () => true,
        fetchImpl
      })
    )
    await manager.start()
    manager.dispose()
    await settlePolling(manager)
    await pollOnce(manager)
    expect(manager.status().uin).toBe('2876349587')
    // writeUinFile 是 fire-and-forget：等文件真的落盘再断言
    let saved = ''
    for (let attempt = 0; attempt < 50 && saved === ''; attempt += 1) {
      saved = await readFile(join(root, 'napcat', 'uin.txt'), 'utf8').catch(() => '')
      if (saved === '') await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(saved.trim()).toBe('2876349587')

    // 新实例（等同 Gotcha 重启）：spawn 的第三个参数就是那个 uin
    const child = { pid: 4321, unref: (): void => {}, on: (): unknown => child }
    const spawnImpl = vi.fn((..._args: unknown[]) => child)
    const next = new NapcatManager(
      deps({
        userDataDir: root,
        getShellDir: () => shell,
        resolveQqPath: async () => 'C:\\Program Files\\QQ.exe',
        isBootmainRunning: async () => false,
        isQqRunning: async () => false,
        spawnImpl: spawnImpl as unknown as NapcatDeps['spawnImpl']
      })
    )
    expect((await next.start()).ok).toBe(true)
    next.dispose()
    const args = spawnImpl.mock.calls[0]?.[1] as string[]
    expect(args[0]).toBe('C:\\Program Files\\QQ.exe')
    expect(args[2]).toBe('2876349587')
  })
})

describe('NapcatManager 停止：收掉自己拉起的链（D105）', () => {
  async function stopManager(overrides: Partial<NapcatDeps> = {}): Promise<{
    manager: NapcatManager
    killTreeImpl: ReturnType<typeof vi.fn>
    userData: string
    spawnImpl: ReturnType<typeof vi.fn>
  }> {
    const userData = await makeDir()
    const shell = await makeShell(join(userData, 'shell'))
    const child = { pid: 4321, unref: (): void => {}, on: (): unknown => child }
    const spawnImpl = vi.fn(() => child)
    const killTreeImpl = vi.fn(async () => undefined)
    const manager = new NapcatManager(
      deps({
        userDataDir: userData,
        getShellDir: () => shell,
        resolveQqPath: async () => 'C:\\Program Files\\QQ.exe',
        fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
        spawnImpl: spawnImpl as unknown as NapcatDeps['spawnImpl'],
        isBootmainRunning: async () => false,
        isQqRunning: async () => false,
        killTreeImpl: killTreeImpl as unknown as NapcatDeps['killTreeImpl'],
        ...overrides
      })
    )
    return { manager, killTreeImpl, userData, spawnImpl }
  }

  it('自己拉起的：停止把整条链结束掉，pid 记录也清掉', async () => {
    const { manager, killTreeImpl, userData } = await stopManager()
    expect((await manager.start()).ok).toBe(true)
    const pidFile = join(userData, 'napcat', 'napcat.pid')
    expect(await readFile(pidFile, 'utf8')).toBe('4321')

    const result = await manager.stop()
    expect(result.ok).toBe(true)
    expect(killTreeImpl).toHaveBeenCalledWith(4321)
    expect(manager.status().phase).toBe('idle')
    await expect(readFile(pidFile, 'utf8')).rejects.toThrow()
    manager.dispose()
  })

  it('接管来的 NapCat：先回 needsConfirm、不动进程；确认后（force）才结束', async () => {
    const { manager, killTreeImpl } = await stopManager({
      isBootmainRunning: async () => true,
      isQqRunning: async () => true,
      findBootmainPid: async () => 777
    })
    expect((await manager.start()).ok).toBe(true)

    const first = await manager.stop()
    expect(first).toEqual({ ok: false, needsConfirm: true })
    expect(killTreeImpl).not.toHaveBeenCalled()
    expect(manager.status().phase).toBe('waiting-login')

    const second = await manager.stop({ force: true })
    expect(second.ok).toBe(true)
    expect(killTreeImpl).toHaveBeenCalledWith(777)
    expect(manager.status().phase).toBe('idle')
    manager.dispose()
  })

  it('Gotcha 重启后按 pid 记录认领上次那条链', async () => {
    const userData = await makeDir()
    await mkdir(join(userData, 'napcat'), { recursive: true })
    await writeFile(join(userData, 'napcat', 'napcat.pid'), '5150', 'utf8')
    const killTreeImpl = vi.fn(async () => undefined)
    const manager = new NapcatManager(
      deps({
        userDataDir: userData,
        isBootmainPid: async () => true,
        killTreeImpl: killTreeImpl as unknown as NapcatDeps['killTreeImpl']
      })
    )

    const result = await manager.stop()
    expect(result.ok).toBe(true)
    expect(killTreeImpl).toHaveBeenCalledWith(5150)
    await expect(readFile(join(userData, 'napcat', 'napcat.pid'), 'utf8')).rejects.toThrow()
    manager.dispose()
  })

  it('pid 被系统复用成别的进程：不杀，只清记录', async () => {
    const userData = await makeDir()
    await mkdir(join(userData, 'napcat'), { recursive: true })
    await writeFile(join(userData, 'napcat', 'napcat.pid'), '5150', 'utf8')
    const killTreeImpl = vi.fn(async () => undefined)
    const manager = new NapcatManager(
      deps({
        userDataDir: userData,
        isBootmainPid: async () => false,
        killTreeImpl: killTreeImpl as unknown as NapcatDeps['killTreeImpl']
      })
    )

    expect((await manager.stop()).ok).toBe(true)
    expect(killTreeImpl).not.toHaveBeenCalled()
    manager.dispose()
  })
})
