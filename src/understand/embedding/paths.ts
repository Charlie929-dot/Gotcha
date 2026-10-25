/**
 * 本地向量模型的位置约定（docs/m2-graph-redesign.md §10；D37）
 *
 * **模型是应用的一部分**：`bge-small-zh-v1.5` 随仓库分发（`resources/models/bge-small-zh-v1.5/`，
 * `model.onnx` 走 git-lfs），打包时用 `extraResources` 带进安装包——用户不需要手工往
 * `%APPDATA%` 里放文件。
 *
 * 查找顺序（第一个「就绪」的胜出，见 `pickEmbeddingModelDir`）：
 * 1. 设置 `graph.embedding_model_dir`——**显式覆盖，权威**：设了就只用它，不再回退；
 * 2. 打包资源目录 `<resourcesPath>/models/<name>`（安装后的位置）；
 * 3. 仓库目录 `<appPath>/resources/models/<name>`（`npm run dev` 从源码跑）；
 * 4. 用户目录 `<userData>/models/<name>`（历史手工放置，保持兼容）。
 *
 * 仍然**不自动下载**：要换模型就自己放进上面任一位置或改设置。
 */

import { join } from 'node:path'
import { EMBEDDING_MODEL_NAME } from './types'

/** 模型目录名（与 EMBEDDING_MODEL_NAME 一致，便于换模型时一眼对应） */
export const EMBEDDING_MODEL_DIR_NAME = EMBEDDING_MODEL_NAME

/** 默认/兜底模型目录：`<userData>/models/bge-small-zh-v1.5`（历史手工位置） */
export function defaultEmbeddingModelDir(userDataDir: string): string {
  return join(userDataDir, 'models', EMBEDDING_MODEL_DIR_NAME)
}

/** 设置值优先（去空白）；空串 / 非法值回退默认目录。保留给只关心单个目录的调用方。 */
export function resolveEmbeddingModelDir(
  userDataDir: string,
  setting: string | null | undefined
): string {
  const trimmed = (setting ?? '').trim()
  if (trimmed === '') return defaultEmbeddingModelDir(userDataDir)
  return trimmed
}

export interface EmbeddingModelLocations {
  /** 设置里的覆盖目录（空串 / undefined = 没设） */
  setting?: string | null
  /** Electron 打包后的 `process.resourcesPath`（dev 下指向 electron 自带 resources） */
  resourcesPath?: string | null
  /** 应用根目录（`app.getAppPath()`；dev 下就是仓库根） */
  appPath?: string | null
  /** `app.getPath('userData')` */
  userDataDir: string
}

/**
 * 按优先级列出候选目录（去重、去空）。
 * 纯函数：不碰文件系统，便于用例断言顺序。
 */
export function embeddingModelCandidates(locations: EmbeddingModelLocations): string[] {
  const setting = (locations.setting ?? '').trim()
  // 显式覆盖是权威的：用户既然指了目录，就只用它——不要悄悄回退到自带模型，
  // 否则「改了设置却没生效」这种情况根本看不出来（2026-10-25 E2E 踩到）。
  if (setting !== '') return [setting]

  const candidates: string[] = []
  const push = (value: string | null | undefined): void => {
    const trimmed = (value ?? '').trim()
    if (trimmed === '' || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }

  if (locations.resourcesPath) {
    push(join(locations.resourcesPath, 'models', EMBEDDING_MODEL_DIR_NAME))
  }
  if (locations.appPath) {
    push(join(locations.appPath, 'resources', 'models', EMBEDDING_MODEL_DIR_NAME))
  }
  push(defaultEmbeddingModelDir(locations.userDataDir))

  return candidates
}

/**
 * 选第一个「就绪」的候选目录；都不就绪时返回第一个候选（让报错 / 日志指向最该放的位置）。
 * `isReady` 由调用方注入（主进程用 `isModelReady`，用例用假实现）。
 */
export function pickEmbeddingModelDir(
  candidates: readonly string[],
  isReady: (dir: string) => boolean
): string {
  if (candidates.length === 0) return ''
  for (const candidate of candidates) {
    if (isReady(candidate)) return candidate
  }
  return candidates[0]
}
