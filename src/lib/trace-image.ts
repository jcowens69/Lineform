export type ScaleMethod = "smooth" | "sharp" | "crisp";

export type TraceSettings = {
  colors: number;
  detail: number;
  smooth: number;
  weight: number;
  stroke: number;
  upscale: number;
  scaleMethod: ScaleMethod;
  lineart: boolean;
  removeBg: boolean;
  tolerance: number;
};

export type TraceLayer = {
  id: number;
  fill: string;
  ds: string[];
  visible: boolean;
  dx: number;
  dy: number;
  role: "background" | "shape";
  name: string;
};

export function isImageFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

export function prepareCanvas(img: HTMLImageElement, settings: TraceSettings) {
  const factor = settings.upscale;
  const maxSide = 2400;
  const longest = Math.max(img.width, img.height) * factor;
  const fit = longest > maxSide ? maxSide / longest : 1;
  const w = Math.max(1, Math.round(img.width * factor * fit));
  const h = Math.max(1, Math.round(img.height * factor * fit));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable");
  ctx.imageSmoothingEnabled = settings.scaleMethod !== "crisp";
  ctx.imageSmoothingQuality = "high";
  if (!settings.removeBg) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  if (settings.scaleMethod === "sharp" && factor > 1) unsharp(ctx, w, h);
  if (settings.removeBg) cutBackground(ctx, w, h, settings.tolerance);
  const image = ctx.getImageData(0, 0, w, h);
  if (settings.weight) adjustLineWeight(image.data, w, h, settings.weight);
  solidify(image.data, w, h, settings.lineart ? 2 : settings.colors);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export async function traceImage(img: HTMLImageElement, settings: TraceSettings) {
  const { VTrace } = await import("@buzz-dee/vtrace");
  const canvas = prepareCanvas(img, settings);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const palette = paletteOf(image.data);
  const smooth = settings.smooth;
  const scale = Math.max(canvas.width, canvas.height) / 1000;
  const tracer = new VTrace(image, {
    clustering: settings.lineart ? "bw" : "color-cluster",
    hierarchical: "cutout",
    mode: "spline",
    maxColors: palette.length || (settings.lineart ? 2 : settings.colors),
    palette: palette.length ? palette : undefined,
    filterSpeckle: Math.round(Math.max(0, 8 - Math.round(settings.detail / 2) + Math.round(smooth / 2)) * scale),
    colorPrecision: 8,
    layerDifference: 28,
    simplify: smooth > 0 ? (0.35 + smooth * 0.45) * scale : undefined,
    lengthThreshold: (4 + smooth * 3.5) * scale,
    cornerThreshold: 60 + smooth * 8,
    spliceThreshold: 45 + smooth * 6,
    maxIterations: 10 + Math.round(smooth),
    pathPrecision: 2,
    optimize: 1,
  });
  tracer.getSVG();
  const svg = (tracer as unknown as { _pathData?: string })._pathData ?? "";
  if (!svg.includes("<path")) throw new Error("Tracer returned no paths");
  return { canvas, layers: parseLayers(svg) };
}

export function composeSvg(layers: TraceLayer[], width: number, height: number, strokeWidth = 0) {
  const body = layers
    .filter((layer) => layer.visible)
    .map((layer) => {
      const stroke =
        strokeWidth > 0
          ? ` stroke="${escapeAttr(layer.fill)}" stroke-width="${strokeWidth}" stroke-linejoin="round"`
          : "";
      const paths = layer.ds
        .map((d) => `<path fill="${escapeAttr(layer.fill)}"${stroke} d="${escapeAttr(d)}"/>`)
        .join("");
      const move = layer.dx || layer.dy ? ` transform="translate(${layer.dx} ${layer.dy})"` : "";
      return `<g id="layer-${layer.id}"${move}>${paths}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

export function toHex(fill: string) {
  const raw = fill.trim().toLowerCase();
  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let body = hex[1];
    if (body.length === 3 || body.length === 4) body = body.slice(0, 3).split("").map((c) => c + c).join("");
    return "#" + body.slice(0, 6).padEnd(6, "0");
  }
  const rgb = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb) {
    return (
      "#" +
      rgb
        .slice(1, 4)
        .map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  if (raw === "black") return "#000000";
  if (raw === "white") return "#ffffff";
  return "#000000";
}

export function formatBytes(n: number) {
  if (!n) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function parseLayers(svg: string): TraceLayer[] {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const box = root.getAttribute("viewBox")?.split(/[\s,]+/).map(Number) ?? [];
  const width = Number(root.getAttribute("width")) || box[2] || 0;
  const height = Number(root.getAttribute("height")) || box[3] || 0;
  const groups = new Map<string, string[]>();
  const highlights: string[] = [];
  let highlightFill = "#ffffff";
  doc.querySelectorAll("path").forEach((path) => {
    const fill = path.getAttribute("fill") || "#000000";
    const d = path.getAttribute("d");
    if (!d) return;
    if (isPaper(fill) && !spansCanvas(d, width, height)) {
      highlightFill = fill;
      highlights.push(d);
      return;
    }
    const list = groups.get(fill) ?? [];
    list.push(d);
    groups.set(fill, list);
  });
  const items: TraceLayer[] = [...groups.entries()].map(([fill, ds], index) => ({
    id: index,
    fill,
    ds,
    visible: true,
    dx: 0,
    dy: 0,
    role: "shape",
    name: "Layer " + (index + 1),
  }));
  const bg = items.find((item) => isPaper(item.fill)) ?? items[0];
  if (bg) {
    bg.role = "background";
    bg.name = "Background";
  }
  const subject = items.find((item) => item.role !== "background");
  if (subject) subject.name = "Subject";
  if (highlights.length) {
    items.push({
      id: items.length,
      fill: highlightFill,
      ds: highlights,
      visible: true,
      dx: 0,
      dy: 0,
      role: "shape",
      name: "White",
    });
  }
  return items;
}

function spansCanvas(d: string, width: number, height: number) {
  if (!width || !height) return false;
  const nums = d.match(/-?\d*\.?\d+/g);
  if (!nums) return false;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]);
    const y = Number(nums[i + 1]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return maxX - minX > width * 0.8 && maxY - minY > height * 0.8;
}

function isPaper(fill: string) {
  const hex = toHex(fill);
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return r > 244 && g > 244 && b > 244;
}

function escapeAttr(value: string) {
  const amp = String.fromCharCode(38);
  return value.split(amp).join(amp + "amp;").split('"').join(amp + "quot;").split("<").join(amp + "lt;");
}

function cutBackground(ctx: CanvasRenderingContext2D, w: number, h: number, tol: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const seeds = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  const seen = new Uint8Array(w * h);
  const stack = seeds.map((offset) => offset / 4);
  const matches = (i: number, seed: number) =>
    Math.abs(data[i] - data[seed]) <= tol &&
    Math.abs(data[i + 1] - data[seed + 1]) <= tol &&
    Math.abs(data[i + 2] - data[seed + 2]) <= tol &&
    data[i + 3] > 10;
  while (stack.length) {
    const p = stack.pop();
    if (p === undefined || seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!seeds.some((seed) => matches(i, seed))) continue;
    data[i + 3] = 0;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  ctx.putImageData(image, 0, 0);
}

function unsharp(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const src = image.data;
  const copy = new Uint8ClampedArray(src);
  const amount = 0.55;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur =
          (copy[i - 4 + c] +
            copy[i + 4 + c] +
            copy[i - w * 4 + c] +
            copy[i + w * 4 + c] +
            copy[i + c] * 4) /
          8;
        src[i + c] = clamp(copy[i + c] + (copy[i + c] - blur) * amount);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

function clamp(n: number) {
  return Math.max(0, Math.min(255, n));
}

const NEIGHBORS = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];

export function adjustLineWeight(data: Uint8ClampedArray, w: number, h: number, weight: number) {
  const magnitude = Math.min(2, Math.abs(weight));
  if (!magnitude) return;
  const passes = Math.ceil(magnitude);
  for (let pass = 0; pass < passes; pass++) {
    snapFringe(data, w, h, weight > 0, Math.min(1, magnitude - pass));
  }
}

function snapFringe(data: Uint8ClampedArray, w: number, h: number, thicken: boolean, strength: number) {
  const src = new Uint8ClampedArray(data);
  const cut = thicken ? 0.42 + strength * 0.28 : 0.58 - strength * 0.28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let minL = 256;
      let maxL = -1;
      let minI = i;
      let maxI = i;
      for (let d = 0; d < NEIGHBORS.length; d += 2) {
        const nx = x + NEIGHBORS[d];
        const ny = y + NEIGHBORS[d + 1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = (ny * w + nx) * 4;
        const L = luminance(src, ni);
        if (L < minL) {
          minL = L;
          minI = ni;
        }
        if (L > maxL) {
          maxL = L;
          maxI = ni;
        }
      }
      if (maxL - minL < 22) continue;
      const L = luminance(src, i);
      if (L <= minL + 6 || L >= maxL - 6) continue;
      const t = (L - minL) / (maxL - minL);
      const target = thicken ? (t < cut ? minI : -1) : t > cut ? maxI : -1;
      if (target < 0) continue;
      data[i] = src[target];
      data[i + 1] = src[target + 1];
      data[i + 2] = src[target + 2];
      data[i + 3] = src[target + 3];
    }
  }
}

function luminance(data: Uint8ClampedArray, i: number) {
  if (data[i + 3] < 16) return 255;
  return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
}

export function solidify(data: Uint8ClampedArray, w: number, h: number, maxColors: number) {
  const hist = new Map<number, number>();
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 14000)));
  let samples = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      hist.set(key, (hist.get(key) ?? 0) + 1);
      samples++;
    }
  }
  const bins = [...hist.entries()].sort((a, b) => b[1] - a[1]);
  const candidates: number[][] = [];
  const gap = 34 * 34;
  const floor = samples * 0.0008;
  let darkNeutral = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue;
      if (chromaAt(data, i) < 16 && data[i] < 48 && data[i + 1] < 48 && data[i + 2] < 48) darkNeutral++;
    }
  }
  for (const [key, count] of bins) {
    if (candidates.length > 0 && count < floor) break;
    const color = [(((key >> 10) & 31) << 3) | 4, (((key >> 5) & 31) << 3) | 4, ((key & 31) << 3) | 4];
    if (candidates.some((ink) => dist2(ink, color) < gap && neutral(ink) === neutral(color))) continue;
    candidates.push(color);
    if (candidates.length >= maxColors * 4) break;
  }
  const palette: number[][] = [];
  for (const color of candidates) {
    if (palette.length >= maxColors) break;
    if (neutral(color) && color[0] < 40) {
      palette.push(color);
      continue;
    }
    if (isBlend(color, palette)) continue;
    palette.push(color);
  }
  if (darkNeutral > samples * 0.004 && !palette.some((ink) => neutral(ink) && ink[0] < 50)) {
    palette.push([12, 12, 12]);
  }
  if (!palette.length) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i + 3] = 0;
      continue;
    }
    let best = palette[0];
    let bestD = Infinity;
    const pixel = [data[i], data[i + 1], data[i + 2]];
    const dark = pixel[0] < 70 && pixel[1] < 70 && pixel[2] < 70;
    const gray = chroma(pixel) < (dark ? 42 : 18);
    const pool = gray ? palette.filter((ink) => chroma(ink) < 32) : palette;
    const choices = pool.length ? pool : palette;
    for (const ink of choices) {
      const d = dist2(ink, pixel);
      if (d < bestD) {
        bestD = d;
        best = ink;
      }
    }
    data[i] = best[0];
    data[i + 1] = best[1];
    data[i + 2] = best[2];
    data[i + 3] = 255;
  }
}

function chroma(color: number[]) {
  return Math.max(color[0], color[1], color[2]) - Math.min(color[0], color[1], color[2]);
}

function chromaAt(data: Uint8ClampedArray, i: number) {
  return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
}

function neutral(color: number[]) {
  return chroma(color) < 18;
}

function dist2(a: number[], b: number[]) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function isBlend(color: number[], palette: number[][]) {
  for (let i = 0; i < palette.length; i++) {
    for (let j = i + 1; j < palette.length; j++) {
      const a = palette[i];
      const b = palette[j];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const abz = b[2] - a[2];
      const ab2 = abx * abx + aby * aby + abz * abz;
      if (ab2 < 900) continue;
      const t = ((color[0] - a[0]) * abx + (color[1] - a[1]) * aby + (color[2] - a[2]) * abz) / ab2;
      if (t <= 0.1 || t >= 0.9) continue;
      const dx = color[0] - (a[0] + abx * t);
      const dy = color[1] - (a[1] + aby * t);
      const dz = color[2] - (a[2] + abz * t);
      if (dx * dx + dy * dy + dz * dz < 28 * 28) return true;
    }
  }
  return false;
}

function paletteOf(data: Uint8ClampedArray) {
  const seen = new Set<number>();
  const colors: string[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push("#" + key.toString(16).padStart(6, "0"));
  }
  return colors;
}
