import { useEffect, useMemo, useRef, useState } from "react";
import { getBearerToken } from "@/lib/auth/client";
import {
  PRINT_DPI,
  cutGeometry,
  knockoutNearWhite,
  maskFromAlpha,
  opaquePlate,
  paintPlate,
} from "@/lib/print-prep";

const NOTE =
  "Mirror, CMYK-then-white, crop marks, Print & Cut, force, and the media profile stay in VersaWorks.";

type Printer = "ty300" | "vg3";
type Garment = "dark" | "light";

type Raster = {
  w: number;
  h: number;
  dpi: number;
  color: ImageData;
  mask: Uint8Array;
};

export function PrintPrep({
  svg,
  width,
  height,
  fileBase,
  disabled,
}: {
  svg: string;
  width: number;
  height: number;
  fileBase: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [printer, setPrinter] = useState<Printer>("ty300");
  const [garment, setGarment] = useState<Garment>("dark");
  const [cutoff, setCutoff] = useState(245);
  const [border, setBorder] = useState(false);
  const [brush, setBrush] = useState(28);
  const [mode, setMode] = useState<"add" | "erase">("add");
  const [raster, setRaster] = useState<Raster | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const plateRef = useRef<Uint8Array | null>(null);
  const colorLayer = useRef<{ canvas: HTMLCanvasElement; image: ImageData } | null>(null);
  const painting = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const token = useRef(0);
  const frame = useRef(0);
  const drawRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!open || !svg || width < 1 || height < 1) return;
    const mine = ++token.current;
    let cancel = false;
    setStatus("Preparing the preview…");
    setError("");
    setRaster(null);
    void renderSvg(svg, width, height)
      .then((image) => {
        if (cancel || mine !== token.current) return;
        const color = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
        if (printer === "ty300" && garment === "light") knockoutNearWhite(color.data, cutoff);
        plateRef.current =
          printer === "ty300" && garment === "dark" ? opaquePlate(color.data) : new Uint8Array(image.width * image.height);
        colorLayer.current = null;
        setRaster({
          w: image.width,
          h: image.height,
          dpi: (PRINT_DPI * image.width) / width,
          color,
          mask: maskFromAlpha(image.data),
        });
        setStatus("");
      })
      .catch(() => {
        if (cancel || mine !== token.current) return;
        setError("The preview could not be prepared.");
        setStatus("");
      });
    return () => {
      cancel = true;
    };
  }, [open, svg, width, height, printer, garment, cutoff]);

  const plan = useMemo(() => {
    if (printer !== "vg3" || !raster) return null;
    return cutGeometry(raster.mask, raster.w, raster.h, border, raster.dpi);
  }, [printer, raster, border]);

  useEffect(() => {
    drawRef.current = () => {
      const canvas = viewRef.current;
      const plate = plateRef.current;
      if (!canvas || !raster || !plate) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const shirtDark = tokenColor("--color-ink", "#1b1914");
      const shirtLight = tokenColor("--color-cream", "#f7f3ea");
      const amber = tokenColor("--color-amber", "#c47b2b");
      const art = colorCanvas(colorLayer, raster.color);
      if (printer === "vg3") {
        const pad = border && plan ? plan.padPx : 0;
        const pageW = Math.max(1, Math.ceil(raster.w + pad * 2));
        const pageH = Math.max(1, Math.ceil(raster.h + pad * 2));
        if (canvas.width !== pageW || canvas.height !== pageH) {
          canvas.width = pageW;
          canvas.height = pageH;
        }
        ctx.clearRect(0, 0, pageW, pageH);
        ctx.fillStyle = border ? "#ffffff" : shirtLight;
        ctx.fillRect(0, 0, pageW, pageH);
        ctx.drawImage(art, pad, pad);
        if (plan) {
          ctx.strokeStyle = amber;
          ctx.lineWidth = Math.max(1.5, pageW / 500);
          ctx.lineJoin = "round";
          for (const ring of plan.cutPx) {
            if (ring.length < 2) continue;
            ctx.beginPath();
            ring.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
            ctx.closePath();
            ctx.stroke();
          }
        }
        return;
      }
      if (canvas.width !== raster.w || canvas.height !== raster.h) {
        canvas.width = raster.w;
        canvas.height = raster.h;
      }
      ctx.clearRect(0, 0, raster.w, raster.h);
      ctx.fillStyle = garment === "dark" ? shirtDark : shirtLight;
      ctx.fillRect(0, 0, raster.w, raster.h);
      if (garment === "dark") {
        ctx.drawImage(plateLayer(plate, raster.w, raster.h, [255, 255, 255, 255]), 0, 0);
        ctx.drawImage(art, 0, 0);
        return;
      }
      ctx.drawImage(art, 0, 0);
      const tint = hexRgb(amber);
      ctx.drawImage(plateLayer(plate, raster.w, raster.h, [tint[0], tint[1], tint[2], 150]), 0, 0);
    };
    drawRef.current();
  }, [open, raster, plan, printer, garment, border]);

  function scheduleDraw() {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      drawRef.current();
    });
  }

  function stamp(x: number, y: number) {
    const canvas = viewRef.current;
    const plate = plateRef.current;
    if (!canvas || !raster || !plate || printer !== "ty300") return;
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width ? canvas.width / rect.width : 1;
    const radius = Math.max(1, (brush / 2) * scale);
    const prev = last.current;
    last.current = { x, y };
    const steps = prev ? Math.max(1, Math.ceil(Math.hypot(x - prev.x, y - prev.y) / Math.max(1, radius / 3))) : 1;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = prev ? prev.x + (x - prev.x) * t : x;
      const py = prev ? prev.y + (y - prev.y) * t : y;
      paintPlate(plate, raster.w, raster.h, px, py, radius, mode === "add" ? 1 : 0);
    }
    scheduleDraw();
  }

  function pointerPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = viewRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  async function download() {
    if (!raster || saving) return;
    setSaving(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        name: fileBase,
        printer,
        width: raster.w,
        height: raster.h,
        dpi: raster.dpi,
        jpeg: toBase64(await jpegBytes(raster.color)),
        alpha: toBase64(await deflateBytes(alphaPlane(raster.color))),
      };
      if (printer === "ty300") {
        const plate = plateRef.current;
        if (!plate) throw new Error("The white plate is not ready.");
        payload.white = toBase64(await deflateBytes(plate));
      } else {
        if (!plan?.cut) throw new Error("No outer edge to cut.");
        payload.cut = plan.cut;
        payload.padPx = border ? plan.padPx : 0;
        if (border) {
          if (!plan.ring) throw new Error("The white border could not be built.");
          payload.ring = plan.ring;
        }
      }
      const body = JSON.stringify(payload);
      if (body.length > 4_200_000) throw new Error("This art is too large to send for printing.");
      const headers: Record<string, string> = { "content-type": "application/json" };
      const bearer = getBearerToken();
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const response = await fetch("/api/export/versaworks", { method: "POST", headers, body });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(failure?.error || "The print file could not be built.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${fileBase || "lineform"}-versaworks.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The print file could not be built.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        className="min-h-11 rounded-full border border-line px-4 font-semibold disabled:opacity-40"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        Prepare for printing
      </button>
      {open ? (
        <section className="mt-3 rounded-2xl border border-line bg-paper p-4">
          <h2 className="font-display text-2xl leading-tight">Prepare for printing</h2>
          <p className="mt-1 text-sm text-muted">Pick a printer. Only that printer’s options are shown. SVG download stays as it is.</p>
          <label className="mt-4 grid gap-2 text-sm text-muted">
            Printer
            <select
              className="min-h-11 rounded-lg border border-line bg-card px-2 text-ink"
              value={printer}
              onChange={(event) => setPrinter(event.target.value as Printer)}
            >
              <option value="ty300">Roland TY-300, DTF</option>
              <option value="vg3">Roland TrueVIS VG3-640, print and cut</option>
            </select>
          </label>

          {printer === "ty300" ? (
            <div className="mt-4 grid gap-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`min-h-11 rounded-full px-4 font-semibold ${garment === "dark" ? "bg-field text-cream" : "border border-line"}`}
                  aria-pressed={garment === "dark"}
                  onClick={() => setGarment("dark")}
                >
                  Dark garment
                </button>
                <button
                  type="button"
                  className={`min-h-11 rounded-full px-4 font-semibold ${garment === "light" ? "bg-field text-cream" : "border border-line"}`}
                  aria-pressed={garment === "light"}
                  onClick={() => setGarment("light")}
                >
                  Light garment
                </button>
              </div>
              {garment === "light" ? (
                <label className="grid gap-2 text-sm text-muted">
                  Knock out whites brighter than {cutoff}. Colored ink stays.
                  <input
                    type="range"
                    min={200}
                    max={254}
                    value={cutoff}
                    onChange={(event) => setCutoff(Number(event.target.value))}
                  />
                </label>
              ) : (
                <p className="text-sm text-muted">Opaque art gets a white underbase named RDG_WHITE.</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`min-h-11 rounded-full px-4 font-semibold ${mode === "add" ? "bg-ink text-cream" : "border border-line"}`}
                  aria-pressed={mode === "add"}
                  onClick={() => setMode("add")}
                >
                  Add white
                </button>
                <button
                  type="button"
                  className={`min-h-11 rounded-full px-4 font-semibold ${mode === "erase" ? "bg-ink text-cream" : "border border-line"}`}
                  aria-pressed={mode === "erase"}
                  onClick={() => setMode("erase")}
                >
                  Remove white
                </button>
              </div>
              <label className="grid gap-2 text-sm text-muted">
                Brush size
                <input type="range" min={8} max={80} value={brush} onChange={(event) => setBrush(Number(event.target.value))} />
              </label>
              <p className="text-sm text-muted">The brush changes the white ink plate only. It does not recolor the art.</p>
            </div>
          ) : (
            <div className="mt-4 grid gap-3">
              <p className="text-sm text-muted">The cut is the outer contour only, as a CutContour stroke. Internal color paths are not cut.</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={border} onChange={(event) => setBorder(event.target.checked)} />
                0.125 in white border
              </label>
              {border ? (
                <p className="text-sm text-muted">
                  The cut moves 0.125 in outside the art. That ring is white ink and white with no CMYK. It is not choked.
                </p>
              ) : null}
            </div>
          )}

          <div className="mt-4">
            {status ? <p className="mb-2 text-sm text-muted">{status}</p> : null}
            <canvas
              ref={viewRef}
              aria-label={printer === "ty300" ? "White ink preview. The brush edits the plate only." : "Cut preview"}
              className={`block h-auto w-full rounded-xl border border-line bg-card ${printer === "ty300" ? "touch-none cursor-crosshair" : ""}`}
              onPointerDown={(event) => {
                if (printer !== "ty300") return;
                event.currentTarget.setPointerCapture(event.pointerId);
                painting.current = true;
                last.current = null;
                const point = pointerPoint(event);
                if (point) stamp(point.x, point.y);
              }}
              onPointerMove={(event) => {
                if (!painting.current || printer !== "ty300") return;
                const point = pointerPoint(event);
                if (point) stamp(point.x, point.y);
              }}
              onPointerUp={() => {
                painting.current = false;
                last.current = null;
              }}
              onPointerCancel={() => {
                painting.current = false;
                last.current = null;
              }}
            />
          </div>

          {printer === "vg3" && raster && !plan ? <p className="mt-3 text-amber">No outer edge to cut.</p> : null}
          {error ? <p className="mt-3 text-amber">{error}</p> : null}
          <button
            type="button"
            className="mt-4 min-h-11 rounded-full bg-field px-4 font-semibold text-cream disabled:opacity-40"
            disabled={!raster || saving || (printer === "vg3" && !plan?.cut)}
            onClick={() => void download()}
          >
            {saving ? "Building PDF…" : "Download PDF"}
          </button>
          <p className="mt-3 text-sm text-muted">{NOTE}</p>
        </section>
      ) : null}
    </div>
  );
}

function colorCanvas(slot: { current: { canvas: HTMLCanvasElement; image: ImageData } | null }, image: ImageData) {
  if (slot.current?.image === image) return slot.current.canvas;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")?.putImageData(image, 0, 0);
  slot.current = { canvas, image };
  return canvas;
}

function plateLayer(plate: Uint8Array, w: number, h: number, rgba: [number, number, number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const image = ctx.createImageData(w, h);
  for (let i = 0; i < plate.length; i++) {
    if (!plate[i]) continue;
    const offset = i * 4;
    image.data[offset] = rgba[0];
    image.data[offset + 1] = rgba[1];
    image.data[offset + 2] = rgba[2];
    image.data[offset + 3] = rgba[3];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function tokenColor(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function hexRgb(hex: string): [number, number, number] {
  const body = hex.replace("#", "").trim();
  if (body.length < 6) return [196, 123, 43];
  return [Number.parseInt(body.slice(0, 2), 16), Number.parseInt(body.slice(2, 4), 16), Number.parseInt(body.slice(4, 6), 16)];
}

async function renderSvg(svg: string, width: number, height: number) {
  const fit = Math.min(1, 1600 / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * fit));
  const h = Math.max(1, Math.round(height * fit));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas is unavailable.");
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The preview could not be prepared."));
    img.src = url;
  });
}

function alphaPlane(image: ImageData) {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) out[p] = image.data[i + 3];
  return out;
}

async function jpegBytes(image: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const layer = document.createElement("canvas");
  layer.width = image.width;
  layer.height = image.height;
  layer.getContext("2d")?.putImageData(image, 0, 0);
  ctx.drawImage(layer, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("The color image could not be built.");
  return new Uint8Array(await blob.arrayBuffer());
}

async function deflateBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array) {
  let text = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(text);
}
