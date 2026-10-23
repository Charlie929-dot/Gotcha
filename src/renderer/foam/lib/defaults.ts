import type { ResolvedStyle } from './types';

/**
 * Gotcha patch F11：默认样式直接使用 Gotcha 暗色主题，不再读取 VS Code 的
 * `--vscode-*` CSS 变量（这些变量在 Electron 页面里取不到，会静默变成蓝色 fallback）。
 */
export function getDefaultStyle(): ResolvedStyle {
  return {
    background: '#121218',
    fontSize: 11,
    fontFamily: 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif',
    lineColor: '#3e4451',
    lineWidth: 0.4,
    particleWidth: 1.0,
    highlightedForeground: '#ffd166',
    node: {
      note: '#cfd8dc',
      knowledge: '#4fc3f7',
      activity: '#81c784',
      protected: '#9e9e9e',
      moment: '#58677c',
      placeholder: '#545454',
      tag: '#f9c74f',
    },
    colorMode: 'type',
    groups: [],
  };
}
