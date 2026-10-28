import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { getDefaultStyle } from './lib/defaults';
import { createGraphModel, computeGraphStates } from './lib/graph-utils';
import {
  computeVisibleGraph,
  deriveNodeTypeFilters,
  type VisibleGraph,
} from './lib/graph-view-model';
import { mergeStyles, resolveStyle } from './lib/style';
import type { GraphData, GraphStyle, GroupRule } from './protocol';
import type {
  GraphModel,
  ResolvedStyle,
  Forces,
  Labels,
  Selection,
  LinkAnimation,
  GraphStates,
} from './lib/types';
import type {
  GraphCanvas,
  NodePosition,
  ViewportPoint,
} from './components/graph-canvas';
import './components/graph-canvas';

/**
 * Gotcha 的 Foam 封装（vendored，见 `src/renderer/foam/UPSTREAM.md`）。
 *
 * 相对上游的交互差异：
 * - F10：控制面板整块移除，改用 Gotcha 自己的设置抽屉；
 * - F13：聚焦用「选中 + 调暗」而不是 `graphScope` 删节点，避免布局跳；
 * - F4：时间筛选外 / 聚焦外的节点只调暗（`dimmedNodeIds`），不删数据；
 * - F7：单击 / 双击由 canvas 的 300ms 计时器拆分，分别派发 `node-click` / `node-open`；
 * - F8：对外暴露 `zoomToFitNodes(ids)`，用于时间筛选后按子集适配相机；
 * - F5：支持位置 seed（`seedPositions`）与沉降后坐标回传（`graph-settled`）。
 */
@customElement('foam-graph')
export class FoamGraph extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
  `;

  // Public API
  @property({ type: Object }) graphData: GraphData | null = null;
  @property({ type: Object }) graphStyle: GraphStyle | null = null;
  /** F13：历史属性保留（外部仍可能设置），但不再用于删节点，只用于选中。 */
  @property({ type: String }) focusNodeId: string | null = null;
  @property({ type: Number }) maxFitZoom: number | null = null;
  @property({ type: Object }) labels: Labels = { fade: 0 };
  @property({ type: Object }) forces: Forces = {
    collide: 1,
    repel: 10,
    link: 30,
    velocityDecay: 0.4,
  };
  @property({ type: Number }) linkWidthMultiplier: number = 2;
  @property({ type: Object }) selection: Selection = {
    neighborDepth: 1,
    centerOnSelect: true,
    zoomOnSelect: false,
  };
  /** F4：时间筛选外的节点（只调暗）。 */
  @property({ type: Object }) dimmedNodeIds: Set<string> | null = null;
  /** F5：上次布局留下的坐标 seed。 */
  @property({ type: Object }) seedPositions: Map<string, ViewportPoint> | null =
    null;
  /** F2：相似度 → 距离的标定值。 */
  @property({ type: Number }) linkDistanceMin: number = 18;
  @property({ type: Number }) linkDistanceMax: number = 140;
  @property({ type: Number }) edgeThreshold: number = 0.64;
  /** F1：成员边默认隐藏。 */
  @property({ type: Boolean }) showMembershipLinks: boolean = false;

  @query('foam-graph-canvas') private canvas!: GraphCanvas;

  // Internal app state
  @state() private graphModel: GraphModel | null = null;
  @state() private selectedNodeIds = new Set<string>();
  @state() private hoverNodeId: string | null = null;
  @state() private showNodesOfType: Record<string, boolean> = {
    note: true,
    tag: true,
    knowledge: true,
    activity: true,
    protected: true,
    moment: true,
  };
  @state() private nodeFontSizeMultiplier: number = 1;
  @state() private nodeSizeMultiplier: number = 1;
  @state() private animateLinks: LinkAnimation = 'forward';
  @state() private localStylePatch: GraphStyle = {};
  @state() private groups: GroupRule[] = [];
  // Pipeline: GraphData -> GraphModel -> VisibleGraph plus GraphStates for rendering.
  @state() private visibleGraph: VisibleGraph | null = null;
  @state() private graphStates: GraphStates | null = null;

  private get resolvedStyle(): ResolvedStyle {
    const merged = mergeStyles(this.graphStyle, this.localStylePatch);
    return resolveStyle(merged, getDefaultStyle());
  }

  updated(changed: Map<string, unknown>) {
    let shouldRecomputeVisibleGraph = false;
    let shouldRecomputeGraphStates = false;

    if (changed.has('graphData')) {
      this.graphModel = this.graphData
        ? createGraphModel(this.graphData)
        : null;
      this._pruneInteractionState();
      shouldRecomputeVisibleGraph = true;
      shouldRecomputeGraphStates = true;
    }

    if (changed.has('graphStyle') && this.graphStyle?.groups) {
      this.groups = this.graphStyle.groups;
      shouldRecomputeVisibleGraph = true;
    }

    if (changed.has('graphStyle') && this.graphStyle?.showNodesOfType) {
      this.showNodesOfType = {
        ...this.showNodesOfType,
        ...this.graphStyle.showNodesOfType,
      };
      shouldRecomputeVisibleGraph = true;
    }

    if (
      (changed.has('graphData') || changed.has('graphStyle')) &&
      this.graphModel
    ) {
      this.showNodesOfType = deriveNodeTypeFilters(
        this.graphModel,
        this.resolvedStyle,
        this.showNodesOfType
      );
      shouldRecomputeVisibleGraph = true;
    }

    if (changed.has('focusNodeId')) {
      this._selectNode(this.focusNodeId ?? '', false);
    }

    if (changed.has('selection') || changed.has('hoverNodeId')) {
      shouldRecomputeGraphStates = true;
    }

    if (changed.has('dimmedNodeIds')) {
      shouldRecomputeGraphStates = true;
    }

    if (shouldRecomputeVisibleGraph) {
      this._recomputeVisibleGraph();
    }
    if (shouldRecomputeGraphStates) {
      this._recomputeGraphStates();
    }
  }

  render() {
    const resolved = this.resolvedStyle;

    return html`
      <foam-graph-canvas
        .visibleGraph=${this.visibleGraph}
        .graphStates=${this.graphStates}
        .canvasStyle=${resolved}
        .groups=${this.groups}
        .forces=${this.forces}
        .labels=${this.labels}
        .nodeFontSizeMultiplier=${this.nodeFontSizeMultiplier}
        .nodeSizeMultiplier=${this.nodeSizeMultiplier}
        .linkWidthMultiplier=${this.linkWidthMultiplier}
        .animateLinks=${this.animateLinks}
        .maxFitZoom=${this.maxFitZoom}
        .seedPositions=${this.seedPositions}
        .linkDistanceMin=${this.linkDistanceMin}
        .linkDistanceMax=${this.linkDistanceMax}
        .edgeThreshold=${this.edgeThreshold}
        .showMembershipLinks=${this.showMembershipLinks}
        @canvas-node-click=${(e: CustomEvent) =>
          this._onCanvasNodeClick(e.detail)}
        @canvas-node-dblclick=${(e: CustomEvent) =>
          this._onCanvasNodeDblClick(e.detail)}
        @canvas-node-hover=${(e: CustomEvent) =>
          (this.hoverNodeId = e.detail)}
        @canvas-background-click=${(e: CustomEvent) =>
          this._onCanvasBackgroundClick(e.detail)}
        @canvas-settled=${(e: CustomEvent) =>
          this.dispatchEvent(
            new CustomEvent('graph-settled', {
              detail: e.detail,
              bubbles: true,
              composed: true,
            })
          )}
      ></foam-graph-canvas>
    `;
  }

  selectNote(noteId: string) {
    this._selectNode(noteId, false);
    if (!this.visibleGraph?.nodeInfo[noteId]) return;
    if (this.selection.centerOnSelect) {
      this.canvas?.centerOnNode(noteId, undefined, 300);
    }
  }

  /** Public: select a node (focus by dimming its surroundings). */
  selectNode(nodeId: string, append = false) {
    this._selectNode(nodeId, append);
  }

  /** Public: clear the current selection. */
  clearSelection() {
    if (this.selectedNodeIds.size === 0) return;
    this.selectedNodeIds = new Set();
    this._recomputeGraphStates();
  }

  /** Public: toggle a node type layer (e.g. hide moments for「只看主题」). */
  setNodeTypeVisible(type: string, visible: boolean) {
    this.showNodesOfType = { ...this.showNodesOfType, [type]: visible };
    this._recomputeVisibleGraph();
    this._recomputeGraphStates();
  }

  /** Public: fit camera to a set of node ids (F8). */
  zoomToFitNodes(ids: Iterable<string>, duration = 400) {
    this.canvas?.zoomToFitNodes(ids, duration);
  }

  zoomToFit(duration = 500) {
    this.canvas?.zoomToFit(duration);
  }

  /** Re-runs the live simulation (F9：保留活布局/惯性，不冻结)。 */
  reheat() {
    this.canvas?.reheat();
  }

  /** Public: current graph-space positions (F5). */
  positions(): NodePosition[] {
    return this.canvas?.positions() ?? [];
  }

  /** P0 性能：累计渲染帧 / 布局 tick（harness 用差值算「布局中 FPS」）。 */
  stats(): { frames: number; ticks: number; bloom: boolean } {
    return this.canvas?.stats() ?? { frames: 0, ticks: 0, bloom: false };
  }

  /** P1-2：窗口隐藏时停动画（引擎 tick + 重绘），可见时恢复。 */
  pauseAnimation() {
    this.canvas?.pauseAnimation();
  }

  resumeAnimation() {
    this.canvas?.resumeAnimation();
  }

  /** Public: viewport position of a node, for E2E real-click tests. */
  nodePosition(nodeId: string): ViewportPoint | null {
    return this.canvas?.nodePosition(nodeId) ?? null;
  }

  /** Public: currently selected node id (first one), if any. */
  selectedId(): string | null {
    return [...this.selectedNodeIds][0] ?? null;
  }

  private _onCanvasNodeClick(detail: { nodeId: string; append: boolean }) {
    this._selectNode(detail.nodeId, detail.append);
    this.dispatchEvent(
      new CustomEvent('node-click', {
        detail: detail.nodeId,
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onCanvasNodeDblClick(detail: { nodeId: string }) {
    // F7：双击 = 打开侧栏/详情，不改变选中集合。
    this.dispatchEvent(
      new CustomEvent('node-open', {
        detail: detail.nodeId,
        bubbles: true,
        composed: true,
      })
    );
  }

  private _onCanvasBackgroundClick(detail: { append: boolean }) {
    if (!detail.append) {
      this.clearSelection();
    }
  }

  private _selectNode(nodeId: string, append: boolean) {
    if (!nodeId) return;
    const next = append ? new Set(this.selectedNodeIds) : new Set<string>();
    next.add(nodeId);
    this.selectedNodeIds = next;
    this._recomputeGraphStates();
    // F12：选中后把相机带过去（缩放可选），与 E2E 的 select 走同一路径。
    if (this.selection.centerOnSelect && this.visibleGraph?.nodeInfo[nodeId]) {
      this.canvas?.centerOnNode(
        nodeId,
        this.selection.zoomOnSelect ? 3 : undefined,
        300
      );
    }
  }

  private _pruneInteractionState() {
    if (!this.graphModel) {
      this.selectedNodeIds = new Set();
      this.hoverNodeId = null;
      return;
    }
    this.selectedNodeIds = new Set(
      [...this.selectedNodeIds].filter(
        id => this.graphModel!.nodeInfo[id] != null
      )
    );
    if (this.hoverNodeId && !this.graphModel.nodeInfo[this.hoverNodeId]) {
      this.hoverNodeId = null;
    }
  }

  private _recomputeVisibleGraph() {
    this.visibleGraph = this.graphModel
      ? computeVisibleGraph(
          this.graphModel,
          this.showNodesOfType,
          this.groups,
          null,
          'full'
        )
      : null;
  }

  private _recomputeGraphStates() {
    this.graphStates = this.graphModel
      ? computeGraphStates(
          this.graphModel,
          this.selectedNodeIds,
          this.hoverNodeId,
          this.selection.neighborDepth,
          this.dimmedNodeIds ?? new Set()
        )
      : null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'foam-graph': FoamGraph;
  }
}
