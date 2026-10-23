import type { RGBColor } from 'd3-color';

interface Circle {
  x: number;
  y: number;
  radius: number;
}

interface Label {
  x: number;
  y: number;
  text: string;
  size: number;
  family: string;
  color: RGBColor;
}

export class Painter {
  /**
   * Gotcha patch（P0 性能）：按颜色字符串分组，而不是按 RGBColor 对象身份。
   * `getNodeFillAndBorder` 每个节点都会新建颜色对象；用对象做 Map 键会让
   * 1010 个节点变成 1010 次 beginPath/fill（约 13 fps），改成字符串后
   * 同色节点合成一批 path（约 45+ fps）。
   */
  private circlesByColor: Map<string, Circle[]> = new Map();
  private bordersByColor: Map<string, Circle[]> = new Map();
  private texts: Label[] = [];
  private screenTexts: Label[] = [];

  private _addCircle(
    x: number,
    y: number,
    radius: number,
    color: RGBColor,
    isBorder = false
  ): void {
    if (color.opacity <= 0) return;
    const key = color.toString();
    const target = isBorder ? this.bordersByColor : this.circlesByColor;
    if (!target.has(key)) target.set(key, []);
    target.get(key)!.push({ x, y, radius });
  }

  private _areSameColor(a: RGBColor, b: RGBColor): boolean {
    return a.r === b.r && a.g === b.g && a.b === b.b && a.opacity === b.opacity;
  }

  circle(x: number, y: number, radius: number, fill: RGBColor, border: RGBColor): this {
    this._addCircle(x, y, radius + 0.2, border, true);
    if (!this._areSameColor(border, fill)) {
      this._addCircle(x, y, radius, fill);
    }
    return this;
  }

  text(
    text: string,
    x: number,
    y: number,
    size: number,
    family: string,
    color: RGBColor
  ): this {
    if (color.opacity > 0) {
      this.texts.push({ x, y, text, size, family, color });
    }
    return this;
  }

  screenText(
    text: string,
    x: number,
    y: number,
    size: number,
    family: string,
    color: RGBColor
  ): this {
    if (color.opacity > 0) {
      this.screenTexts.push({ x, y, text, size, family, color });
    }
    return this;
  }

  paint(ctx: CanvasRenderingContext2D): this {
    // Draw borders first, then fills
    for (const target of [this.bordersByColor, this.circlesByColor]) {
      for (const [color, circles] of target.entries()) {
        ctx.beginPath();
        ctx.fillStyle = color;
        for (const c of circles) {
          // 每个圆单独起一个子路径；只 arc 不 moveTo 会把圆之间连成填充块。
          ctx.moveTo(c.x + c.radius, c.y);
          ctx.arc(c.x, c.y, c.radius, 0, 2 * Math.PI, false);
        }
        ctx.closePath();
        ctx.fill();
      }
      target.clear();
    }

    // Draw labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const label of this.texts) {
      ctx.font = `${label.size}px ${label.family}`;
      ctx.fillStyle = label.color.toString();
      ctx.fillText(label.text, label.x, label.y);
    }
    this.texts = [];

    if (this.screenTexts.length > 0) {
      ctx.save();
      const devicePixelRatio = window.devicePixelRatio || 1;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const label of this.screenTexts) {
        ctx.font = `${label.size}px ${label.family}`;
        ctx.fillStyle = label.color.toString();
        ctx.fillText(label.text, label.x, label.y);
      }
      ctx.restore();
      this.screenTexts = [];
    }

    return this;
  }
}
