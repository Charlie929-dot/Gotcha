import type { GraphStyle } from '../protocol';
import type { ResolvedStyle } from './types';

/**
 * Merges two GraphStyles, with `patch` taking precedence over `base`.
 */
export function mergeStyles(
  base: GraphStyle | null,
  patch: GraphStyle
): GraphStyle {
  return {
    ...base,
    ...patch,
    style: { ...base?.style, ...patch?.style },
  };
}

/**
 * Resolves a GraphStyle into a fully-populated ResolvedStyle by merging
 * user-supplied values on top of the provided defaults.
 */
export function resolveStyle(
  payload: GraphStyle | null,
  defaults: ResolvedStyle
): ResolvedStyle {
  if (!payload) return defaults;
  // Gotcha patch：StyleConfig.node 的值允许 undefined（部分覆盖），
  // 这里显式过滤，避免把 undefined 塞进 ResolvedStyle.node 的 string 索引签名。
  const node: Record<string, string> = { ...defaults.node };
  for (const [key, value] of Object.entries(payload.style?.node ?? {})) {
    if (value !== undefined) node[key] = value;
  }
  return {
    ...defaults,
    ...payload.style,
    lineColor:
      payload.style?.lineColor ||
      payload.style?.node?.note ||
      defaults.lineColor,
    node: node as ResolvedStyle['node'],
    colorMode: payload.colorMode ?? defaults.colorMode,
    groups: payload.groups ?? defaults.groups,
  };
}
