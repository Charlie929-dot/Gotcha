import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
// force-graph 的 .d.ts 把它声明成 class（constructor(element)），但运行时默认导出是
// Kapsule 工厂函数（`ForceGraph()(element)`）；按运行时用法断言，避免被错的类型声明误导。
import ForceGraphImport from 'force-graph';
import {
  forceX,
  forceY,
  forceCollide,
  forceManyBody,
  forceLink,
} from 'd3-force';
import { scaleLinear } from 'd3-scale';
import { Painter } from '../lib/painter';
import {
  getNodeFillAndBorder,
  getLinkColor,
  getNodeLabelColor,
} from '../lib/colors';
import { distanceFromSim } from '../lib/distance';
import { computeBloomLayout, momentOrbitPoint } from '../lib/bloom-layout';
import { GraphModelLink } from '../lib/types';
import type {
  GraphStates,
  ResolvedStyle,
  Forces,
  Labels,
  LinkAnimation,
} from '../lib/types';
import type { GroupRule } from '../protocol';
import type { VisibleGraph } from '../lib/graph-view-model';

const ForceGraph = ForceGraphImport as unknown as (
  element?: HTMLElement
) => any;

export interface GraphViewportSize {
  width: number;
  height: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

export interface GraphBounds {
  x: [number, number];
  y: [number, number];
}

export interface NodePosition {
  id: string;
  x: number;
  y: number;
}

/** 时刻点标签只在放大到该倍率后显示（方案 §7.2「标题悬停/放大才显示」）。 */
const MOMENT_LABEL_SCALE = 2.2;
/** 成员边默认不画（方案 §7.2：默认很淡/不可见，仅参与力与高亮）。 */
const MEMBERSHIP_DISTANCE = 36;

/**
 * Gotcha patch F11（P1-2）：超过这个节点数就不再给连线挂「流动粒子」。
 *
 * force-graph 的动画循环条件是「引擎在跑 **或** 任一 link 上有 `__photons`」，
 * 而全局图的粒子宽度只在连线高亮时非零 —— 4k 节点的图上等于「看不见的粒子」把
 * 每一帧都拖着重画一次（4k 点 ≈ 10 ms/帧，沉降后 CPU 一直下不来）。小图保留粒子，
 * 大图关闭；隐藏窗口时还会整体暂停动画（见 `pauseAnimation`）。
 */
const LARGE_GRAPH_NODE_LIMIT = 1500;

/**
 * P1-2 LOD（2026-10-28 晚）：超过这个节点数就「静态展开」。
 *
 * 4k 节点的全局图里 88% 是时刻点，而时刻点没有位置 seed —— 它们从随机位置开始，
 * 靠力导跑 180 tick 才散开（每 tick 30–55 ms，用户要等 9 s）。超过这条线以后：
 * - 主题用库里的 seed（没 seed 的挂到已定位邻居旁边）；
 * - 时刻按「绕自己主题的黄金角螺旋」直接算出来（`lib/bloom-layout.ts`，确定性纯函数）；
 * - 全部节点钉住（`fx/fy`）并把引擎的 tick 预算压到 1，打开即静。
 * 小图完全不受影响，仍是原来的活布局。
 */
const BLOOM_NODE_LIMIT = 2000;

export function measureGraphViewport(
  element: HTMLElement,
  fallback: GraphViewportSize
): GraphViewportSize {
  const rect = element.getBoundingClientRect();
  const parent = element.parentElement;
  const parentRect = parent?.getBoundingClientRect();
  return {
    width:
      rect.width ||
      element.clientWidth ||
      parentRect?.width ||
      parent?.clientWidth ||
      fallback.width,
    height:
      rect.height ||
      element.clientHeight ||
      parentRect?.height ||
      parent?.clientHeight ||
      fallback.height,
  };
}

export function graphPointToViewport(
  transform: DOMMatrixReadOnly,
  x: number,
  y: number,
  devicePixelRatio: number
): ViewportPoint {
  const ratio = devicePixelRatio || 1;
  return {
    x: (transform.a * x + transform.c * y + transform.e) / ratio,
    y: (transform.b * x + transform.d * y + transform.f) / ratio,
  };
}

export function computeLabelFontSize(
  baseFontSize: number,
  multiplier: number
): number {
  return baseFontSize * multiplier;
}

export function computeLabelOpacity(
  state: string,
  globalScale: number,
  fillOpacity: number,
  getOpacity: (scale: number) => number,
  labels: Labels
): number {
  if (labels === 'always' || state === 'highlighted') return 1;
  const opacity = getOpacity(globalScale);
  return state === 'regular' ? opacity : Math.min(opacity, fillOpacity);
}

export function computeFitZoom(
  bounds: GraphBounds,
  viewport: GraphViewportSize,
  padding: number,
  maxZoom?: number | null
): number {
  const availableWidth = Math.max(viewport.width - padding * 2, 1);
  const availableHeight = Math.max(viewport.height - padding * 2, 1);
  const graphWidth = Math.max(bounds.x[1] - bounds.x[0], 1e-12);
  const graphHeight = Math.max(bounds.y[1] - bounds.y[0], 1e-12);
  const fitZoom = Math.max(
    1e-12,
    Math.min(1e12, availableWidth / graphWidth, availableHeight / graphHeight)
  );
  return maxZoom == null ? fitZoom : Math.min(fitZoom, maxZoom);
}

interface CanvasNode {
  id: string;
  x?: number;
  y?: number;
  /** 静态展开（P1-2 LOD）时钉住坐标：force-graph 不会移动带 fx/fy 的节点 */
  fx?: number;
  fy?: number;
}

@customElement('foam-graph-canvas')
export class GraphCanvas extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: absolute;
      inset: 0;
    }

    #canvas-container {
      width: 100%;
      height: 100%;
    }
  `;

  /**
   * Pre-filtered graph data ready for rendering. `nodeInfo` should contain only
   * visible nodes.
   */
  @property({ type: Object }) visibleGraph: VisibleGraph | null = null;
  @property({ type: Object }) graphStates: GraphStates | null = null;
  /** 注：不能叫 `style`（与 HTMLElement.style 冲突），由 foam-graph 的 `.canvasStyle` 传入。 */
  @property({ type: Object }) canvasStyle: ResolvedStyle = {} as ResolvedStyle;
  @property({ type: Object }) forces: Forces = {
    collide: 2,
    repel: 30,
    link: 30,
    velocityDecay: 0.4,
  };
  @property({ type: Object }) labels: Labels = { fade: 0 };
  @property({ type: Number }) nodeFontSizeMultiplier: number = 1;
  @property({ type: Number }) nodeSizeMultiplier: number = 1;
  @property({ type: Number }) linkWidthMultiplier: number = 2;
  @property({ type: String }) animateLinks: LinkAnimation = 'forward';
  @property({ type: Array }) groups: GroupRule[] = [];
  @property({ type: Number }) maxFitZoom: number | null = null;

  /**
   * Gotcha patch F5：位置 seed。键为节点 id，值为上次布局留下的坐标；
   * 只在创建节点时使用，沉降后再通过 `canvas-settled` 事件回传。
   */
  @property({ type: Object }) seedPositions: Map<string, ViewportPoint> | null =
    null;
  /** Gotcha patch F2：主题边距离范围（相似度 → 距离的标定值）。 */
  @property({ type: Number }) linkDistanceMin: number = 18;
  @property({ type: Number }) linkDistanceMax: number = 140;
  @property({ type: Number }) edgeThreshold: number = 0.64;
  /** Gotcha patch F1：成员边默认隐藏，但仍参与力布局。 */
  @property({ type: Boolean }) showMembershipLinks: boolean = false;

  // Mutable rendering state closed over by force-graph callbacks.
  private rs = {
    nodeInfo: {} as VisibleGraph['nodeInfo'],
    data: { nodes: [] as CanvasNode[], links: [] as GraphModelLink[] },
    graphStates: null as GraphStates | null,
    style: {} as ResolvedStyle,
    forces: {} as Forces,
    nodeFontSizeMultiplier: 1,
    nodeSizeMultiplier: 1,
    linkWidthMultiplier: 2,
    animateLinks: 'forward' as LinkAnimation,
    colorMode: 'type' as 'none' | 'directory' | 'type',
    groups: [] as GroupRule[],
    showMembershipLinks: false,
  };

  private readonly getDegreeSize = scaleLinear()
    .domain([0, 30])
    .range([0.6, 3])
    .clamp(true);
  private readonly getNodeLabelOpacity = scaleLinear()
    .domain([1.2, 2.0])
    .range([0, 1])
    .clamp(true);

  private graphInstance: any = null;
  private firstGraphLoad = true;
  private firstFitPending = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onResize = () => this.resizeGraphToViewport();
  private lastClick = { id: '', at: 0 };
  private clickTimer: number | null = null;
  /** P0 性能测量：实际渲染帧数与布局 tick 数（harness 采样，不参与渲染逻辑）。 */
  private renderedFrames = 0;
  private engineTicks = 0;
  /** 当前连线粒子数（0 = 大图省电模式，见 LARGE_GRAPH_NODE_LIMIT）。 */
  private particleCount = 1;
  /** P1-2 LOD：当前是否「静态展开」（见 BLOOM_NODE_LIMIT）。 */
  private blooming = false;
  /** 「重排」在静态模式下只换一个角度：布局是确定性的，换角度就是可见的变化。 */
  private bloomRotation = 0;
  /** 主题 id → 成员时刻 id（按节点顺序，拖完主题按同一套螺旋重摆）。 */
  private momentMembers = new Map<string, string[]>();

  private readonly linkDistance = (link: GraphModelLink): number =>
    (link.kind ?? 'embedding') === 'membership'
      ? MEMBERSHIP_DISTANCE
      : distanceFromSim(
          link.weight ?? 1,
          this.edgeThreshold,
          this.linkDistanceMin,
          this.linkDistanceMax
        );

  private readonly collideRadius = (node: CanvasNode): number =>
    this.nodeRadius(node) + 1.5;

  private readonly linkVisibility = (link: GraphModelLink): boolean =>
    this.rs.showMembershipLinks || (link.kind ?? 'embedding') !== 'membership';

  render() {
    return html`<div id="canvas-container"></div>`;
  }

  firstUpdated() {
    const container = this.shadowRoot!.getElementById(
      'canvas-container'
    ) as HTMLDivElement;
    container.addEventListener('mouseleave', () => {
      this._emit('canvas-node-hover', null);
    });
    const painter = new Painter();

    this.graphInstance = ForceGraph()(container)
      .graphData(this.rs.data as any)
      .backgroundColor(this.rs.style.background || '#121218')
      .linkHoverPrecision(8)
      .d3Force('x', forceX())
      .d3Force('y', forceY())
      .d3Force('collide', forceCollide(this.collideRadius))
      .d3Force(
        'charge',
        forceManyBody().strength(-(this.rs.forces.repel || 30))
      )
      .d3Force(
        'link',
        forceLink(this.rs.data.links as any).distance(
          this.linkDistance as any
        )
      )
      .d3VelocityDecay(1 - (this.rs.forces.velocityDecay ?? 0.4))
      .linkWidth(() => this.rs.style.lineWidth * this.rs.linkWidthMultiplier)
      .linkVisibility(this.linkVisibility)
      .linkDirectionalParticles(1)
      .linkDirectionalParticleSpeed(
        this.rs.animateLinks === 'reverse' ? -0.004 : 0.004
      )
      .linkDirectionalParticleWidth((link: any) => {
        if (this.rs.animateLinks === 'off') return 0;
        const graphLink = link as GraphModelLink;
        const key = GraphModelLink.getKey(graphLink);
        const state = this.rs.graphStates?.linkStates.get(key) ?? 'regular';
        return state === 'highlighted' ? this.rs.style.particleWidth : 0;
      })
      .nodeCanvasObject(
        (node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const info = this.rs.nodeInfo[node.id];
          if (!info) return;

          const size = this.nodeRadius(node);
          const state =
            this.rs.graphStates?.nodeStates.get(node.id) ?? 'regular';
          const { fill, border } = getNodeFillAndBorder(
            info,
            state,
            this.rs.style,
            this.rs.colorMode,
            this.rs.groups
          );
          const fontSize = computeLabelFontSize(
            this.rs.style.fontSize,
            this.rs.nodeFontSizeMultiplier
          );
          const opacity = computeLabelOpacity(
            state,
            globalScale,
            fill.opacity,
            scale => this.getNodeLabelOpacity(scale),
            this.labels
          );

          const textColor = getNodeLabelColor(
            fill,
            state,
            opacity,
            this.rs.style
          );

          const labelPosition = graphPointToViewport(
            ctx.getTransform(),
            node.x,
            node.y + size + 1,
            window.devicePixelRatio || 1
          );

          painter.circle(node.x, node.y, size, fill, border);

          // Gotcha patch F3：时刻点默认不画标签（避免 2k 标签压盖），放大或高亮时才显示。
          const isMoment = info.type === 'moment';
          if (
            isMoment &&
            state !== 'highlighted' &&
            globalScale < MOMENT_LABEL_SCALE
          ) {
            return;
          }

          painter.screenText(
            info.title,
            labelPosition.x,
            labelPosition.y,
            fontSize,
            this.rs.style.fontFamily,
            textColor as any
          );
        }
      )
      .onRenderFramePost((ctx: CanvasRenderingContext2D) => {
        this.renderedFrames += 1;
        painter.paint(ctx);
      })
      .linkColor((link: any) => {
        const graphLink = link as GraphModelLink;
        const key = GraphModelLink.getKey(graphLink);
        const state = this.rs.graphStates?.linkStates.get(key) ?? 'regular';
        const srcInfo =
          this.rs.nodeInfo[GraphModelLink.getNodeId(graphLink.source)];
        const tgtInfo =
          this.rs.nodeInfo[GraphModelLink.getNodeId(graphLink.target)];
        return getLinkColor(
          state,
          srcInfo?.type ?? 'note',
          tgtInfo?.type ?? 'note',
          this.rs.style
        );
      })
      .nodePointerAreaPaint(
        (node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const info = this.rs.nodeInfo[node.id];
          if (!info) return;
          const size = this.nodeRadius(node);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
          ctx.fill();
        }
      )
      .onNodeHover((node: any) => {
        const nodeId = node?.id ?? null;
        this._emit('canvas-node-hover', nodeId);
        container.style.cursor = node ? 'pointer' : 'default';
      })
      .onNodeClick((node: any, event: MouseEvent) => {
        this._handleNodeClick(node.id, event.getModifierState('Shift'));
      })
      .onBackgroundClick((event: MouseEvent) => {
        this._emit('canvas-background-click', {
          append: event.getModifierState('Shift'),
        });
      })
      .onEngineStop(() => this._handleEngineStop())
      .onEngineTick(() => {
        this.engineTicks += 1;
      })
      .onNodeDragEnd((node: any) => {
        this._handleNodeDragEnd(node as CanvasNode);
      });

    this.resizeGraphToViewport();
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() =>
        this.resizeGraphToViewport()
      );
      this.resizeObserver.observe(this);
    }
    window.addEventListener('resize', this.onResize);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.clickTimer !== null) {
      window.clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onResize);
    (this.graphInstance as any)?._destructor?.();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('canvasStyle')) {
      this.rs.style = this.canvasStyle;
      this.rs.colorMode = this.canvasStyle.colorMode;
      this.graphInstance?.backgroundColor(this.canvasStyle.background);
    }

    if (changed.has('graphStates')) {
      this.rs.graphStates = this.graphStates;
      // Gotcha patch F4：调暗/高亮变化后强制重绘（force-graph 没有 refresh 接口）。
      this._refreshCanvas();
    }

    if (changed.has('forces')) {
      this.rs.forces = this.forces;
      if (this.graphInstance) {
        (this.graphInstance.d3Force('charge') as any)?.strength(
          -this.forces.repel
        );
        // Gotcha patch F2：力变化时保持「相似度→距离」函数，不要重置成常数。
        (this.graphInstance.d3Force('link') as any)?.distance(this.linkDistance);
        (this.graphInstance.d3Force('collide') as any)?.radius(
          this.collideRadius
        );
        this.graphInstance.d3VelocityDecay(1 - this.forces.velocityDecay);
        this.graphInstance.d3ReheatSimulation();
      }
    }

    if (changed.has('groups')) {
      this.rs.groups = this.groups;
    }

    if (changed.has('labels')) {
      if (typeof this.labels === 'object') {
        const invertedValue = 3 - this.labels.fade;
        this.getNodeLabelOpacity.domain([invertedValue, invertedValue + 0.8]);
      }
    }

    if (changed.has('nodeFontSizeMultiplier')) {
      this.rs.nodeFontSizeMultiplier = this.nodeFontSizeMultiplier;
    }

    if (changed.has('nodeSizeMultiplier')) {
      this.rs.nodeSizeMultiplier = this.nodeSizeMultiplier;
    }

    if (changed.has('linkWidthMultiplier')) {
      this.rs.linkWidthMultiplier = this.linkWidthMultiplier;
      this.graphInstance?.linkWidth(
        () => this.rs.style.lineWidth * this.rs.linkWidthMultiplier
      );
    }

    if (changed.has('animateLinks')) {
      this.rs.animateLinks = this.animateLinks;
      this.graphInstance?.linkDirectionalParticleSpeed(
        this.animateLinks === 'reverse' ? -0.004 : 0.004
      );
    }

    if (changed.has('showMembershipLinks')) {
      this.rs.showMembershipLinks = this.showMembershipLinks;
      this.graphInstance?.linkVisibility(this.linkVisibility as any);
      this._refreshCanvas();
    }

    if (changed.has('visibleGraph')) {
      const nextGraph: VisibleGraph = this.visibleGraph ?? {
        nodeInfo: {},
        nodes: [],
        links: [],
      };
      this.rs.nodeInfo = nextGraph.nodeInfo;
      this._updateGraphData(nextGraph);

      if (this.visibleGraph && this.firstGraphLoad && this.graphInstance) {
        this.firstGraphLoad = false;
        this.firstFitPending = true;
        // Gotcha patch F2/F6：先让活布局沉降，再按包围盒适配。
        // P1-2：静态展开的大图不需要沉降，别把 tick 预算又调回 180
        if (!this.blooming) this.graphInstance.cooldownTicks(180);
      }
    }
  }

  /** Centers the viewport on a currently visible node. */
  centerOnNode(nodeId: string, zoom?: number, duration = 300) {
    if (!this.graphInstance) return;
    const node = this.rs.data.nodes.find(n => n.id === nodeId);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    this.graphInstance.centerAt(node.x, node.y, duration);
    if (zoom !== undefined) {
      this.graphInstance.zoom(zoom, duration);
    }
  }

  /** Fits the current graph into the available canvas area. */
  zoomToFit(duration = 500) {
    if (!this.graphInstance) return;
    if (this.maxFitZoom == null) {
      this.graphInstance.zoomToFit(duration);
      return;
    }

    const graphInstance = this.graphInstance as any;
    const bounds = graphInstance.getGraphBbox?.() as GraphBounds | null;
    if (!bounds) return;
    this._fitBounds(bounds, duration);
  }

  /**
   * Gotcha patch F8：按子集包围盒适配相机（时间筛选后只框住 focused 节点）。
   */
  zoomToFitNodes(ids: Iterable<string>, duration = 400) {
    if (!this.graphInstance) return;
    const wanted = new Set(ids);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const node of this.rs.data.nodes) {
      if (!wanted.has(node.id)) continue;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      xs.push(node.x as number);
      ys.push(node.y as number);
    }
    if (xs.length === 0) return;
    this._fitBounds(
      {
        x: [Math.min(...xs), Math.max(...xs)],
        y: [Math.min(...ys), Math.max(...ys)],
      },
      duration
    );
  }

  /** Current zoom level, without changing the graph data. */
  zoom(zoom: number, duration = 300) {
    this.graphInstance?.zoom(zoom, duration);
  }

  /** P0 性能：累计渲染帧 / 布局 tick（harness 用差值算「布局中 FPS」）。 */
  stats(): { frames: number; ticks: number; bloom: boolean } {
    return { frames: this.renderedFrames, ticks: this.engineTicks, bloom: this.blooming };
  }

  /** P1-2：窗口隐藏时停掉 rAF 循环（引擎 tick 与重绘都停），可见再恢复。 */
  pauseAnimation() {
    (this.graphInstance as any)?.pauseAnimation?.();
  }

  resumeAnimation() {
    (this.graphInstance as any)?.resumeAnimation?.();
  }

  /** Re-runs the live simulation (harness「重排」/ 布局手感调试用). */
  reheat() {
    // 静态展开模式没有力导可跑：换一个角度重算，用户能看到「排了一次」
    if (this.blooming) {
      this.bloomRotation += 0.9
      this._updateGraphData(
        this.visibleGraph ?? { nodeInfo: {}, nodes: [], links: [] }
      )
      return
    }
    this.graphInstance?.d3ReheatSimulation();
  }

  /** Current graph-space coordinates of every node (used for position persistence). */
  positions(): NodePosition[] {
    const out: NodePosition[] = [];
    for (const node of this.rs.data.nodes) {
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) {
        out.push({ id: node.id, x: node.x as number, y: node.y as number });
      }
    }
    return out;
  }

  /** Viewport (CSS pixel, page coordinates) position of a node, for E2E real-click tests. */
  nodePosition(nodeId: string): ViewportPoint | null {
    if (!this.graphInstance) return null;
    const node = this.rs.data.nodes.find(n => n.id === nodeId);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      return null;
    }
    const point = (this.graphInstance as any).graph2ScreenCoords(
      node.x,
      node.y
    ) as ViewportPoint;
    // force-graph 返回的是画布内坐标，换算成页面坐标（含工具栏偏移）。
    const container = this.shadowRoot?.getElementById('canvas-container');
    const rect = container?.getBoundingClientRect();
    return {
      x: (rect?.left ?? 0) + point.x,
      y: (rect?.top ?? 0) + point.y,
    };
  }

  private _fitBounds(bounds: GraphBounds, duration: number) {
    if (!this.graphInstance) return;
    const center = {
      x: (bounds.x[0] + bounds.x[1]) / 2,
      y: (bounds.y[0] + bounds.y[1]) / 2,
    };
    const viewport = measureGraphViewport(this, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const zoom = computeFitZoom(bounds, viewport, 24, this.maxFitZoom);
    this.graphInstance.centerAt(center.x, center.y, duration);
    this.graphInstance.zoom(zoom, duration);
  }

  private _handleNodeClick(nodeId: string, append: boolean) {
    const now = Date.now();
    if (this.lastClick.id === nodeId && now - this.lastClick.at < 300) {
      if (this.clickTimer !== null) {
        window.clearTimeout(this.clickTimer);
        this.clickTimer = null;
      }
      this.lastClick = { id: '', at: 0 };
      // Gotcha patch F7：force-graph 只有 onNodeClick，双击由 300ms 计时器识别。
      this._emit('canvas-node-dblclick', { nodeId });
      return;
    }
    this.lastClick = { id: nodeId, at: now };
    if (this.clickTimer !== null) window.clearTimeout(this.clickTimer);
    this.clickTimer = window.setTimeout(() => {
      this.clickTimer = null;
      this._emit('canvas-node-click', { nodeId, append });
    }, 300);
  }

  private _handleEngineStop() {
    // Gotcha patch F5：布局沉降后回传坐标，供上层（P1 起落库）保存。
    this._emit('canvas-settled', this.positions());
    if (this.firstFitPending) {
      this.firstFitPending = false;
      this.zoomToFit(400);
    }
  }

  /**
   * Gotcha patch F3：节点半径 = `properties.size`（回退到度数映射）。
   * 主题 6–22、时刻 2–3，由上层 adapter 计算。
   */
  private nodeRadius(node: CanvasNode): number {
    const info = this.rs.nodeInfo[node.id];
    const raw = info?.properties?.size;
    const multiplier = this.rs.nodeSizeMultiplier || 1;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0.5, Math.min(40, raw)) * multiplier;
    }
    return this.getDegreeSize(info?.neighbors.length ?? 0) * multiplier;
  }

  /** 只看类型的半径（静态展开排时刻轨道用；没有节点对象也能算）。 */
  private _themeRadiusOf(id: string): number {
    const raw = this.rs.nodeInfo[id]?.properties?.size;
    const multiplier = this.rs.nodeSizeMultiplier || 1;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(0.5, Math.min(40, raw)) * multiplier;
    }
    return 3 * multiplier;
  }

  private _updateGraphData(visibleGraph: VisibleGraph) {
    if (!this.graphInstance) return;

    // P1-2 LOD：大图先算静态坐标（确定性），小图照旧交给力导
    const bloomPositions =
      visibleGraph.nodes.length > BLOOM_NODE_LIMIT
        ? computeBloomLayout({
            nodes: visibleGraph.nodes,
            links: visibleGraph.links,
            typeOf: id => this.rs.nodeInfo[id]?.type,
            sizeOf: id => this._themeRadiusOf(id),
            seeds: this.seedPositions,
            rotation: this.bloomRotation
          })
        : null;

    const nodeIdsToAdd = new Set(visibleGraph.nodes.map(node => node.id));
    const nodeIdsToRemove = new Set<string>();

    for (const node of this.rs.data.nodes) {
      if (nodeIdsToAdd.has(node.id)) {
        nodeIdsToAdd.delete(node.id);
      } else {
        nodeIdsToRemove.add(node.id);
      }
    }

    for (const id of nodeIdsToRemove) {
      const idx = this.rs.data.nodes.findIndex(node => node.id === id);
      if (idx !== -1) this.rs.data.nodes.splice(idx, 1);
    }
    for (const id of nodeIdsToAdd) {
      const seed = bloomPositions?.get(id) ?? this.seedPositions?.get(id);
      this.rs.data.nodes.push(
        seed ? { id, x: seed.x, y: seed.y } : { id }
      );
    }

    this.rs.data.links = visibleGraph.links.map(link => ({ ...link }));
    // P1-2：大图关掉流动粒子（必须在 graphData 之前设，光子数组是在 graphData 变更时重建的）
    const nextParticles = visibleGraph.nodes.length > LARGE_GRAPH_NODE_LIMIT ? 0 : 1;
    if (nextParticles !== this.particleCount) {
      this.particleCount = nextParticles;
      this.graphInstance.linkDirectionalParticles(nextParticles);
    }
    // force-graph 的更新是节流的（约 17ms）：它先 `.nodes()` 再 `.links()`。
    // 图清空时若 link force 还挂着旧边，`.nodes([])` 会因找不到端点直接抛错，
    // 所以节点为空时先把 link force 的边清掉（Gotcha patch F5 稳定性）。
    if (this.rs.data.nodes.length === 0) {
      (this.graphInstance.d3Force('link') as any)?.links([]);
    }
    this._applyBloomLayout(bloomPositions);
    this.graphInstance.graphData(this.rs.data as any);
    this._refreshCanvas();
  }

  /**
   * 静态展开：把坐标钉到节点上（`fx/fy`）并把引擎 tick 预算压到 1；
   * 退出静态模式时解钉并让引擎重新跑（否则节点会永远停在旧坐标）。
   */
  private _applyBloomLayout(positions: Map<string, { x: number; y: number }> | null) {
    const wasBlooming = this.blooming;
    this.blooming = positions !== null;
    this.momentMembers = new Map();

    if (!positions) {
      for (const node of this.rs.data.nodes) {
        delete node.fx;
        delete node.fy;
      }
      this.graphInstance?.cooldownTicks(180);
      // 从静态模式退回来：图变了但引擎没在跑，不重加热会一直停着
      if (wasBlooming) this.graphInstance?.d3ReheatSimulation();
      return;
    }

    for (const node of this.rs.data.nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      node.x = point.x;
      node.y = point.y;
      node.fx = point.x;
      node.fy = point.y;
    }

    // 主题 → 成员时刻：按节点顺序分组，和 computeBloomLayout 的螺旋序号同源
    const themesOfMoment = new Map<string, string[]>();
    for (const link of this.rs.data.links) {
      if ((link.kind ?? 'embedding') !== 'membership') continue;
      const source = GraphModelLink.getNodeId(link.source);
      const target = GraphModelLink.getNodeId(link.target);
      if (!source || !target) continue;
      const list = themesOfMoment.get(target) ?? [];
      list.push(source);
      themesOfMoment.set(target, list);
    }
    const ringCount = new Map<string, number>();
    for (const node of this.rs.data.nodes) {
      const themes = themesOfMoment.get(node.id);
      const primary = themes?.[0];
      if (!primary) continue;
      const index = ringCount.get(primary) ?? 0;
      ringCount.set(primary, index + 1);
      const list = this.momentMembers.get(primary) ?? [];
      list.push(node.id);
      this.momentMembers.set(primary, list);
    }

    this.graphInstance?.warmupTicks(0).cooldownTicks(1);
  }

  /** 拖完一个主题：成员时刻绕新位置重摆（静态模式下没有力导，不重摆就会掉在原地）。 */
  private _handleNodeDragEnd(node: CanvasNode) {
    if (!this.blooming) return;
    const members = this.momentMembers.get(node.id);
    if (!members || members.length === 0) return;
    const center = { x: node.x ?? 0, y: node.y ?? 0 };
    const byId = new Map(this.rs.data.nodes.map(item => [item.id, item]));
    for (let index = 0; index < members.length; index += 1) {
      const member = byId.get(members[index]);
      if (!member) continue;
      const point = momentOrbitPoint(
        node.id,
        index,
        center,
        this.bloomRotation,
        this._themeRadiusOf(node.id) + 7
      );
      member.x = point.x;
      member.y = point.y;
      member.fx = point.x;
      member.fy = point.y;
    }
    this._refreshCanvas();
  }

  private _refreshCanvas() {
    // force-graph 没有 refresh()：把当前 nodeCanvasObject 重新 set 一次即可触发重绘。
    const g = this.graphInstance as any;
    if (!g) return;
    const fn = g.nodeCanvasObject();
    if (typeof fn === 'function') g.nodeCanvasObject(fn);
  }

  private resizeGraphToViewport() {
    if (!this.graphInstance) return;
    const { width, height } = measureGraphViewport(this, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (width <= 0 || height <= 0) return;
    this.graphInstance.width(width).height(height);
  }

  private _emit(eventName: string, detail: unknown) {
    this.dispatchEvent(
      new CustomEvent(eventName, { detail, bubbles: true, composed: true })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'foam-graph-canvas': GraphCanvas;
  }
}
