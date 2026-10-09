export const PRINT_DPI = 300;
export const BORDER_INCH = 0.125;

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

export type Pt = { x: number; y: number };

export function knockoutNearWhite(data: Uint8ClampedArray, cutoff: number) {
  const limit = Math.max(0, Math.min(255, cutoff));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > 18) continue;
    const bright = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (bright >= limit) data[i + 3] = 0;
  }
}

export function keepPrintLayer(fill: string, role: "background" | "shape", visible: boolean) {
  if (!visible) return false;
  return !(role === "background" && paperFill(fill));
}

function paperFill(fill: string) {
  const raw = fill.trim().toLowerCase();
  let body = "";
  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    body = hex[1];
    if (body.length <= 4) body = body.slice(0, 3).split("").map((part) => part + part).join("");
    body = body.slice(0, 6);
  } else if (raw === "white") body = "ffffff";
  else return false;
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  return r > 244 && g > 244 && b > 244;
}

export function opaquePlate(data: Uint8ClampedArray) {
  const plate = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) plate[p] = data[i + 3] > 20 ? 255 : 0;
  return plate;
}

export function maskFromAlpha(data: Uint8ClampedArray) {
  const mask = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) mask[p] = data[i + 3] > 24 ? 1 : 0;
  return mask;
}

export function paintPlate(
  plate: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  radius: number,
  value: number,
) {
  const r = Math.max(1, radius);
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(w - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(h - 1, Math.ceil(y + r));
  const ink = value > 0 ? 255 : 0;
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * w;
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - x;
      const dy = yy - y;
      if (dx * dx + dy * dy <= r2) plate[row + xx] = ink;
    }
  }
}

export function dilateDisk(mask: Uint8Array, w: number, h: number, radius: number) {
  const r = Math.max(1, Math.ceil(radius));
  const width = w + r * 2;
  const height = h + r * 2;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) out[(y + r) * width + (x + r)] = 1;
    }
  }
  const r2 = radius * radius;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const left = x > 0 && mask[y * w + x - 1];
      const right = x + 1 < w && mask[y * w + x + 1];
      const up = y > 0 && mask[(y - 1) * w + x];
      const down = y + 1 < h && mask[(y + 1) * w + x];
      if (left && right && up && down) continue;
      const cx = x + r;
      const cy = y + r;
      for (let dy = -r; dy <= r; dy++) {
        const span = r2 - dy * dy;
        if (span < 0) continue;
        const reach = Math.sqrt(span);
        const x0 = Math.max(0, Math.floor(cx - reach));
        const x1 = Math.min(width - 1, Math.ceil(cx + reach));
        out.fill(1, (cy + dy) * width + x0, (cy + dy) * width + x1 + 1);
      }
    }
  }
  return { mask: out, w: width, h: height, ox: r, oy: r };
}

export function outerContours(mask: Uint8Array, w: number, h: number): Pt[][] {
  const seen = new Uint8Array(w * h);
  const contours: Pt[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || seen[start]) continue;
      if (x > 0 && mask[start - 1]) continue;
      const points = walkOuter(mask, w, h, x, y);
      flood(mask, seen, w, h, x, y);
      const simplified = simplify(points, 1.15);
      if (simplified.length >= 4 && Math.abs(signedArea(simplified)) > 2) contours.push(simplified);
    }
  }
  return contours;
}

export type CutPlan = {
  pageW: number;
  pageH: number;
  cut: string;
  ring: string;
  padPx: number;
  cutPx: Pt[][];
};

export function cutGeometry(mask: Uint8Array, w: number, h: number, border: boolean, dpi = PRINT_DPI): CutPlan | null {
  const maxSide = 900;
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const fitted = scale === 1 ? { mask, w, h } : downsample(mask, w, h, scale);
  const padPx = border ? BORDER_INCH * dpi : 0;
  let work = fitted.mask;
  let ww = fitted.w;
  let hh = fitted.h;
  let inner: Pt[][] = [];
  if (border) {
    const found = outerContours(fitted.mask, fitted.w, fitted.h);
    const dilated = dilateDisk(fitted.mask, fitted.w, fitted.h, Math.max(1, padPx * scale));
    work = dilated.mask;
    ww = dilated.w;
    hh = dilated.h;
    inner = found.map((ring) => ring.map((point) => ({ x: point.x + dilated.ox, y: point.y + dilated.oy })));
  }
  const outers = outerContours(work, ww, hh);
  if (!outers.length) return null;
  const pageW = w + padPx * 2;
  const pageH = h + padPx * 2;
  return {
    pageW,
    pageH,
    cut: toOps(outers, scale, pageH, dpi),
    ring: border && inner.length ? toOps([...outers, ...inner], scale, pageH, dpi) : "",
    padPx,
    cutPx: toPx(outers, scale),
  };
}

function downsample(mask: Uint8Array, w: number, h: number, scale: number) {
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.min(h - 1, Math.floor(y / scale));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.min(w - 1, Math.floor(x / scale));
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let on = 0;
      for (let yy = y0; yy < y1 && !on; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          if (mask[yy * w + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * width + x] = on;
    }
  }
  return { mask: out, w: width, h: height };
}

function toOps(contours: Pt[][], scale: number, pageH: number, dpi: number) {
  const s = 72 / dpi;
  const parts: string[] = [];
  for (const ring of contours) {
    if (ring.length < 3) continue;
    const first = pt(ring[0], scale, pageH, s);
    parts.push(`${first.x} ${first.y} m`);
    for (let i = 1; i < ring.length; i++) {
      const next = pt(ring[i], scale, pageH, s);
      parts.push(`${next.x} ${next.y} l`);
    }
    parts.push("h");
  }
  return parts.join("\n");
}

function toPx(contours: Pt[][], scale: number) {
  return contours
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((point) => ({ x: point.x / scale, y: point.y / scale })));
}

function pt(point: Pt, scale: number, pageH: number, s: number) {
  const x = (point.x / scale) * s;
  const y = (pageH - point.y / scale) * s;
  return { x: num(x), y: num(y) };
}

function num(value: number) {
  return (Math.round(value * 100) / 100).toString();
}

function walkOuter(mask: Uint8Array, w: number, h: number, sx: number, sy: number) {
  const points: Pt[] = [{ x: sx, y: sy }];
  let x = sx;
  let y = sy;
  let back = 4;
  const limit = Math.max(64, w * h);
  for (let step = 0; step < limit; step++) {
    let found = false;
    for (let turn = 1; turn <= 8; turn++) {
      const nextDir = (back + turn) & 7;
      const nx = x + NEIGHBORS[nextDir][0];
      const ny = y + NEIGHBORS[nextDir][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) continue;
      x = nx;
      y = ny;
      back = (nextDir + 4) & 7;
      found = true;
      break;
    }
    if (!found || (x === sx && y === sy)) break;
    points.push({ x, y });
  }
  return points;
}

function flood(mask: Uint8Array, seen: Uint8Array, w: number, h: number, sx: number, sy: number) {
  const stack = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (stack.length) {
    const index = stack.pop() as number;
    const x = index % w;
    const y = (index - x) / w;
    for (let n = 0; n < 8; n++) {
      const nx = x + NEIGHBORS[n][0];
      const ny = y + NEIGHBORS[n][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const next = ny * w + nx;
      if (seen[next] || !mask[next]) continue;
      seen[next] = 1;
      stack.push(next);
    }
  }
}

function signedArea(points: Pt[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function simplify(points: Pt[], epsilon: number) {
  if (points.length < 6) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop() as [number, number];
    let far = 0;
    let index = -1;
    const a = points[start];
    const b = points[end];
    for (let i = start + 1; i < end; i++) {
      const dist = segmentDistance(points[i], a, b);
      if (dist > far) {
        far = dist;
        index = i;
      }
    }
    if (index >= 0 && far > epsilon) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function segmentDistance(point: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  if (!len) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}
