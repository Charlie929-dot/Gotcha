/**
 * 编译 `native/chain-hook`（Windows / x64）
 *
 * 为什么不用 `node-gyp`：本机 VS 2026 的 **MSBuild 是坏的**
 * （`System.Memory` 程序集版本不匹配，`MSBuild could not start`），而 node-gyp 走的就是
 * MSBuild + .sln。cl.exe / link.exe / Windows SDK 反而是好的。所以这里直接调编译器：
 * `vcvars64.bat` 配环境 → `cl /LD` 出 `.node`。
 *
 * 依赖的东西（缺了会自动补）：
 * - `vcvars64.bat`：从 `vswhere` 或常见安装目录里找；
 * - Node 头文件 + node.lib：优先用 node-gyp 的缓存（`%LOCALAPPDATA%\node-gyp\Cache\<ver>`），
 *   没有就用 `curl` + `tar` 从 nodejs.org 取到 `.tmp/node-headers/`。
 *
 * 用法：`npm run build:native`
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const nodeVersion = process.versions.node
const isWindows = process.platform === 'win32'

function fail(message) {
  console.error(`\n[build:native] ${message}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

if (!isWindows) fail('这个 addon 只在 Windows 上编译（JS 侧加载失败会降级为无采集）')

/* ---------------------------------------------------------------- */
/* 1. vcvars64.bat                                                  */
/* ---------------------------------------------------------------- */

function findVcvars() {
  const fromEnv = process.env.VCINSTALLDIR
  if (fromEnv) {
    const candidate = join(fromEnv, 'Auxiliary', 'Build', 'vcvars64.bat')
    if (existsSync(candidate)) return candidate
  }

  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)']
  ].filter(Boolean)
  const years = ['18', '2022', '2019', '2017']
  const editions = ['Community', 'BuildTools', 'Professional', 'Enterprise']

  // 先问 vswhere（装完整时会给出准确路径）
  const vswhere = join(roots[1] ?? '', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (existsSync(vswhere)) {
    const result = run(vswhere, ['-all', '-prerelease', '-products', '*', '-property', 'installationPath'])
    const paths = (result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    for (const base of paths) {
      const candidate = join(base, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
      if (existsSync(candidate)) return candidate
    }
  }

  for (const root of roots) {
    for (const year of years) {
      const yearDir = join(root, 'Microsoft Visual Studio', year)
      if (!existsSync(yearDir)) continue
      for (const edition of editions) {
        const candidate = join(yearDir, edition, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
        if (existsSync(candidate)) return candidate
      }
      // 有的版本把 edition 放在上一层
      for (const entry of readdirSync(yearDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(yearDir, entry.name, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

const vcvars = findVcvars()
if (!vcvars) {
  fail(
    '找不到 vcvars64.bat。需要装 Visual Studio（或 Build Tools）并勾上「使用 C++ 的桌面开发」/「C++ 生成工具」。\n' +
      '  装好后 C:\\Program Files\\Microsoft Visual Studio\\<版本>\\<版本名>\\VC\\Auxiliary\\Build\\vcvars64.bat 应当存在。'
  )
}
console.log(`[build:native] 编译器环境：${vcvars}`)

/* ---------------------------------------------------------------- */
/* 2. Node 头文件与 node.lib                                        */
/* ---------------------------------------------------------------- */

const cacheRoot = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'node-gyp', 'Cache', nodeVersion)
  : null
const localRoot = join(repoRoot, '.tmp', 'node-headers')

function resolveNodeSdk() {
  const fromCache = cacheRoot && existsSync(join(cacheRoot, 'include', 'node', 'node_api.h'))
  if (fromCache) {
    const lib = join(cacheRoot, 'x64', 'node.lib')
    if (existsSync(lib)) return { include: join(cacheRoot, 'include', 'node'), nodeLib: lib }
  }

  const extracted = join(localRoot, `node-v${nodeVersion}`, 'include', 'node')
  const lib = join(localRoot, 'x64', 'node.lib')
  if (existsSync(join(extracted, 'node_api.h')) && existsSync(lib)) return { include: extracted, nodeLib: lib }

  // 自己取：curl + tar 都是 Windows 10+ 自带
  mkdirSync(join(localRoot, 'x64'), { recursive: true })
  const base = `https://nodejs.org/download/release/v${nodeVersion}`
  const tarball = join(localRoot, `node-v${nodeVersion}-headers.tar.gz`)
  console.log(`[build:native] 下载 Node 头文件 ${nodeVersion}…`)
  if (!existsSync(tarball)) {
    const curl = run('curl', ['-fsSL', '-o', tarball, `${base}/node-v${nodeVersion}-headers.tar.gz`])
    if (curl.status !== 0) fail(`下载头文件失败：${curl.stderr ?? ''}`)
  }
  const untar = run('tar', ['-xzf', tarball, '-C', localRoot])
  if (untar.status !== 0) fail(`解压头文件失败：${untar.stderr ?? ''}`)
  const curlLib = run('curl', ['-fsSL', '-o', lib, `${base}/win-x64/node.lib`])
  if (curlLib.status !== 0) fail(`下载 node.lib 失败：${curlLib.stderr ?? ''}`)

  if (!existsSync(join(extracted, 'node_api.h'))) fail(`头文件解压后找不到 node_api.h：${extracted}`)
  return { include: extracted, nodeLib: lib }
}

const sdk = resolveNodeSdk()
console.log(`[build:native] Node 头文件：${sdk.include}`)

/* ---------------------------------------------------------------- */
/* 3. 编译                                                          */
/* ---------------------------------------------------------------- */

const moduleDir = join(repoRoot, 'native', 'chain-hook')
const outDir = join(moduleDir, 'build', 'Release')
const objDir = join(moduleDir, 'build', 'obj')
mkdirSync(outDir, { recursive: true })
mkdirSync(objDir, { recursive: true })

const sources = ['src\\chain_hook.cc', 'src\\win_delay_load_hook.cc']
const defines = [
  '/DNAPI_VERSION=8',
  '/DNODE_GYP_MODULE_NAME=chain_hook',
  '/DUNICODE',
  '/D_UNICODE',
  '/DNOMINMAX',
  '/DWIN32_LEAN_AND_MEAN',
  '/DNDEBUG'
].join(' ')

const asSlash = (path) => path.replace(/\\/g, '/')

const script = [
  '@echo off',
  `call "${vcvars}" >nul || exit /b 9`,
  `cd /d "${moduleDir}"`,
  [
    'cl /nologo /LD /O2 /MD /EHsc /std:c++17',
    defines,
    `/I"${asSlash(sdk.include)}"`,
    // 结尾用 / 而不是 \：cmd 里 \" 会被当成转义引号
    `/Fo"${asSlash(objDir)}/"`,
    `/Fd"${asSlash(objDir)}/chain_hook.pdb"`,
    sources.join(' '),
    `/link /DLL /OUT:"${asSlash(join(outDir, 'chain_hook.node'))}"`,
    // 不指定 IMPLIB 的话 link 会把 .lib/.exp 扔在源码目录里
    `/IMPLIB:"${asSlash(join(objDir, 'chain_hook.lib'))}"`,
    `/PDB:"${asSlash(join(objDir, 'chain_hook.pdb'))}"`,
    `"${asSlash(sdk.nodeLib)}" user32.lib version.lib delayimp.lib`,
    // 把 node.exe 的符号请求转到宿主进程（node.exe 或 electron.exe）
    '/DELAYLOAD:node.exe',
    '/NOLOGO'
  ].join(' '),
  'exit /b %ERRORLEVEL%'
].join('\r\n')

const scriptPath = join(repoRoot, '.tmp', 'build-chain-hook.bat')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })
writeFileSync(scriptPath, `${script}\r\n`, 'utf8')

console.log('[build:native] 编译中…')
const build = spawnSync('cmd', ['/c', scriptPath], { encoding: 'utf8' })
const output = `${build.stdout ?? ''}${build.stderr ?? ''}`
if (build.status !== 0) {
  console.error(output.trim())
  console.error(`\n[build:native] 生成的编译脚本在 ${scriptPath}\n`)
  fail(`编译失败（退出码 ${build.status}）`)
}
const noisy = output
  .split(/\r?\n/)
  .filter((line) => line.trim() && !/^(chain_hook\.cc|win_delay_load_hook\.cc)$/.test(line.trim()))
if (noisy.length > 0) console.log(noisy.join('\n'))

/* ---------------------------------------------------------------- */
/* 4. 验证能加载                                                    */
/* ---------------------------------------------------------------- */

const artifact = join(outDir, 'chain_hook.node')
if (!existsSync(artifact)) fail(`编译结束但没找到产物：${artifact}`)

const probe = spawnSync(
  process.execPath,
  ['-e', `const m = require(${JSON.stringify(artifact)}); console.log('loaded', m.version, typeof m.start, typeof m.stop, typeof m.lastInputTickMs)`],
  { encoding: 'utf8' }
)
if (probe.status !== 0) fail(`产物加载失败：\n${probe.stdout ?? ''}\n${probe.stderr ?? ''}`)

console.log(`[build:native] 完成：${artifact}`)
console.log(`[build:native] ${(probe.stdout ?? '').trim()}`)
console.log('[build:native] 下一步可跑：npm run chain-hook-smoke -- 20')
