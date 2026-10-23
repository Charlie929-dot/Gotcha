import type { NodeInfo, GroupRule } from '../protocol';

export interface GraphModelNode extends NodeInfo {
  neighbors: string[];
  links: GraphModelLink[];
}

export interface GraphModelLink {
  source: string | GraphModelNode;
  target: string | GraphModelNode;
  /** Gotcha patch F1：主题→主题的余弦相似度（0–1），用于距离编码。 */
  weight?: number;
  /** Gotcha patch F1：'embedding'（主题间相似边）/ 'membership'（主题→时刻成员边）。 */
  kind?: string;
}

export abstract class GraphModelLink {
  static getNodeId(endpoint: GraphModelLink['source']): string {
    return typeof endpoint === 'object' ? endpoint.id : endpoint;
  }

  static getKey(link: GraphModelLink): string {
    return `${GraphModelLink.getNodeId(link.source)}->${GraphModelLink.getNodeId(
      link.target
    )}`;
  }
}

export interface GraphModel {
  nodeInfo: Record<string, GraphModelNode>;
  links: GraphModelLink[];
}

export interface ResolvedStyle {
  background: string;
  fontSize: number;
  fontFamily: string;
  lineColor: string;
  lineWidth: number;
  particleWidth: number;
  highlightedForeground: string;
  node: {
    note: string;
    placeholder: string;
    tag: string;
    [key: string]: string;
  };
  colorMode: 'none' | 'directory' | 'type';
  groups: GroupRule[];
}

/**
 * Gotcha patch F4：把原来的 `lessened` 换成 `dimmed`（透明度 0.16–0.20），
 * 既用于时间筛选外的节点（只调暗、不删数据），也用于局部聚焦时被压暗的节点（F13）。
 */
export type NodeState = 'regular' | 'highlighted' | 'dimmed';
export type LinkState = 'regular' | 'highlighted' | 'dimmed';

export interface GraphStates {
  nodeStates: Map<string, NodeState>;
  /** Keyed by "sourceId->targetId" for identity-safe lookup across copied link objects. */
  linkStates: Map<string, LinkState>;
}

export interface Forces {
  collide: number;
  repel: number;
  link: number;
  velocityDecay: number;
}

export type LinkAnimation = 'forward' | 'off' | 'reverse';

export type GraphScope = 'full' | { depth: number };

export type Labels = 'always' | { fade: number };

export interface Selection {
  neighborDepth: number;
  centerOnSelect: boolean;
  zoomOnSelect: boolean;
}
