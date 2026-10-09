import { useEffect, useRef, useState } from "react";
import { ImagePlus, Menu, X } from "lucide-react";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getMembership, startCheckout } from "@/lib/billing";
import { stampPreview } from "@/lib/watermark";
import { PrintPrep } from "@/components/print-prep";
import { keepPrintLayer } from "@/lib/print-prep";
import {
  composeSvg,
  formatBytes,
  isImageFile,
  toHex,
  traceImage,
  type TraceLayer,
  type TraceSettings,
} from "@/lib/trace-image";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp";

const INITIAL: TraceSettings = {
  colors: 16,
  detail: 12,
  smooth: 2,
  weight: -1,
  stroke: 0,
  upscale: 1,
  scaleMethod: "smooth",
  lineart: false,
  removeBg: false,
  tolerance: 28,
};

export function Studio() {
  const [settings, setSettings] = useState<TraceSettings>(INITIAL);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("");
  const [size, setSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [layers, setLayers] = useState<TraceLayer[]>([]);
  const [svg, setSvg] = useState("");
  const [vectorPreview, setVectorPreview] = useState("");
  const [fileBytes, setFileBytes] = useState(0);
  const [member, setMember] = useState(false);
  const [memberReady, setMemberReady] = useState(false);
  const [payError, setPayError] = useState("");
  const [payBusy, setPayBusy] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [dims, setDims] = useState({ w: 1, h: 1 });
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tokenRef = useRef(0);
  const dragDepth = useRef(0);
  const cleanRef = useRef("");
  const { user, isPending } = useCurrentUserState();

  useEffect(() => {
    if (isPending) return;
    if (!user) {
      setMember(false);
      setMemberReady(true);
      return;
    }
    let cancel = false;
    getMembership()
      .then((row) => {
        if (!cancel) setMember(row.active);
      })
      .catch(() => {
        if (!cancel) setMember(false);
      })
      .finally(() => {
        if (!cancel) setMemberReady(true);
      });
    return () => {
      cancel = true;
    };
  }, [user, isPending]);

  useEffect(() => {
    const allow = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      allow(event);
      dragDepth.current += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void takeFile(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", allow);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", allow);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [settings]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) void takeFile(file);
          break;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [settings]);

  useEffect(() => {
    const img = imageRef.current;
    if (!img || revision === 0) return;
    const token = ++tokenRef.current;
    setBusy(true);
    setError("");
    const handle = window.setTimeout(() => {
      traceImage(img, settings)
        .then((result) => {
          if (token !== tokenRef.current) return;
          canvasRef.current = result.canvas;
          setPreviewUrl(result.canvas.toDataURL("image/png"));
          setDims({ w: result.canvas.width, h: result.canvas.height });
          setLayers(result.layers);
        })
        .catch((err: unknown) => {
          if (token !== tokenRef.current) return;
          const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
          setError(message || "Could not trace this image.");
        })
        .finally(() => {
          if (token === tokenRef.current) setBusy(false);
        });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [
    revision,
    settings.colors,
    settings.detail,
    settings.smooth,
    settings.weight,
    settings.upscale,
    settings.scaleMethod,
    settings.lineart,
    settings.removeBg,
    settings.tolerance,
    3,
  ]);

  useEffect(() => {
    if (!layers.length) return;
    const next = composeSvg(layers, dims.w, dims.h, settings.stroke);
    cleanRef.current = next;
    setFileBytes(next.length);
    if (member) {
      setSvg(next);
      setVectorPreview("");
      return;
    }
    setSvg("");
    let cancel = false;
    void stampPreview(next, dims.w, dims.h).then((url) => {
      if (!cancel) setVectorPreview(url);
    });
    return () => {
      cancel = true;
    };
  }, [layers, dims, settings.stroke, member]);

  function updateLayers(next: TraceLayer[]) {
    setLayers(next);
  }

  async function takeFile(file: File) {
    if (!isImageFile(file)) {
      setError("Use a PNG, JPG, WebP, GIF, or BMP.");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadHtmlImage(url);
      imageRef.current = img;
      setName(file.name || "image.png");
      setSize(file.size);
      setRevision((n) => n + 1);
      setError("");
    } catch {
      setError("That file could not be opened.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function onInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void takeFile(file);
  }

  function loadSample() {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 420;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f4efe4";
    ctx.fillRect(0, 0, 640, 420);
    ctx.fillStyle = "#243f34";
    ctx.beginPath();
    ctx.arc(210, 210, 92, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c47b2b";
    roundRect(ctx, 300, 118, 210, 184, 28);
    ctx.fill();
    ctx.fillStyle = "#f7f3ea";
    ctx.font = "700 54px Georgia";
    ctx.fillText("Lf", 168, 228);
    ctx.fillStyle = "#1a120c";
    ctx.font = "600 42px Georgia";
    ctx.fillText("SVG", 348, 226);
    canvas.toBlob((blob) => {
      if (blob) void takeFile(new File([blob], "sample-mark.png", { type: "image/png" }));
    });
  }

  function downloadSvg() {
    const file = cleanRef.current;
    if (!member || !file) return;
    const blob = new Blob([file], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = baseName(name) + ".svg";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPng() {
    if (!member) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = baseName(name) + "-cutout.png";
    a.click();
  }

  const hasImage = Boolean(name);
  const printBody = member
    ? composeSvg(
        layers.filter((layer) => keepPrintLayer(layer.fill, layer.role, layer.visible)),
        dims.w,
        dims.h,
        settings.stroke,
      )
    : "";
  const printSvg = printBody.includes("<path") ? printBody : svg;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <SiteHeader member={member} />

      <main className="px-5 pb-16 sm:px-10">
        <section className="mb-6 max-w-2xl">
          <p className="text-xs font-semibold tracking-widest text-field uppercase">Raster to vector</p>
          <h1 className="font-display mt-2 text-5xl leading-none font-medium sm:text-6xl">
            Turn pixels into clean paths.
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-muted">
            {member
              ? "Drop a logo or illustration. Your downloads are the clean SVG."
              : "Drop a logo or illustration, or choose a file. The preview is watermarked. A plan downloads the clean SVG."}
          </p>
          <p className="mt-3 max-w-xl text-muted">
            Convert a PNG, JPG, or WebP into clean SVG paths. Colors become layers you can edit, then download a file for Illustrator or Figma.
          </p>
        </section>

        <section id="studio" className="rounded-3xl border border-line bg-card shadow-lg">
          {!hasImage ? (
            <div className="relative min-h-96">
              <input
                id="lineform-file"
                type="file"
                accept={ACCEPT}
                aria-label="Choose an image to vectorize"
                className="absolute inset-0 z-10 h-full w-full opacity-0"
                onChange={onInput}
              />
              <div className="pointer-events-none flex min-h-96 flex-col items-center justify-center px-6 text-center">
                <ImagePlus className="size-10 text-field" aria-hidden="true" />
                <p className="font-display mt-3 text-3xl">Drag an image here</p>
                <p className="mt-1 text-muted">PNG, JPG, WebP, GIF, or BMP. You can also paste.</p>
                <span className="mt-5 inline-flex min-h-11 items-center rounded-full bg-field px-5 font-semibold text-cream">
                  Choose image
                </span>
              </div>
              <button
                type="button"
                className="absolute bottom-8 left-1/2 z-20 min-h-11 -translate-x-1/2 rounded-full border border-line bg-card px-5 font-semibold"
                onClick={loadSample}
              >
                Try a sample
              </button>
            </div>
          ) : (
            <div className="p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold">
                  {name} <span className="font-normal text-muted">{formatBytes(size)}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <label className="relative inline-flex min-h-11 items-center rounded-full border border-line px-4 font-semibold">
                    Replace
                    <input
                      type="file"
                      accept={ACCEPT}
                      aria-label="Replace image"
                      className="absolute inset-0 h-full w-full opacity-0"
                      onChange={onInput}
                    />
                  </label>
                  <button
                    type="button"
                    className="min-h-11 rounded-full border border-line px-4 font-semibold disabled:opacity-40"
                    disabled={!member || !previewUrl}
                    onClick={downloadPng}
                  >
                    {member ? "Cutout PNG" : "Members only"}
                  </button>
                  {member ? (
                    <button
                      type="button"
                      className="min-h-11 rounded-full bg-field px-4 font-semibold text-cream disabled:opacity-40"
                      disabled={!svg}
                      onClick={downloadSvg}
                    >
                      Download SVG
                    </button>
                  ) : (
                    <a href="#plans" className="inline-flex min-h-11 items-center rounded-full bg-field px-4 font-semibold text-cream">
                      Unlock SVG
                    </a>
                  )}
                </div>
              </div>
              {member ? (
                <PrintPrep svg={printSvg} width={dims.w} height={dims.h} fileBase={baseName(name)} disabled={!svg || busy} />
              ) : (
                <a
                  href="#plans"
                  className="mt-3 inline-flex min-h-11 items-center rounded-full border border-line px-4 font-semibold"
                >
                  Prepare for printing
                </a>
              )}

              <div className="grid min-w-0 gap-3 md:grid-cols-2">
                <figure className="min-w-0">
                  <figcaption className="mb-2 text-xs tracking-widest text-muted uppercase">Pixels</figcaption>
                  <div className="grid min-h-72 place-items-center rounded-2xl border border-line bg-paper p-4">
                    {previewUrl ? (
                      <img src={previewUrl} alt="" className="max-h-96 max-w-full" />
                    ) : null}
                  </div>
                </figure>
                <VectorZoom svg={svg} src={vectorPreview} busy={busy} />
              </div>

              {error ? <p className="mt-3 text-amber">{error}</p> : null}
              <p className="mt-3 text-muted">
                <strong className="text-ink">{layers.reduce((count, layer) => count + layer.ds.length, 0)}</strong> paths
                <span className="px-2">·</span>
                <strong className="text-ink">{layers.length}</strong> layers
                <span className="px-2">·</span>
                <strong className="text-ink">{settings.upscale}×</strong> {settings.scaleMethod}
                <span className="px-2">·</span>
                {formatBytes(fileBytes)} SVG
              </p>

              <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
                <Slider label="Colors" min={2} max={32} value={settings.colors} onChange={(colors) => setSettings({ ...settings, colors })} />
                <Slider label="Detail" min={1} max={16} value={settings.detail} onChange={(detail) => setSettings({ ...settings, detail })} />
                <Slider label="Smooth" min={0} max={4} step={0.25} value={settings.smooth} onChange={(smooth) => setSettings({ ...settings, smooth })} />
                <Slider
                  label="Line weight"
                  min={-2}
                  max={2}
                  step={0.5}
                  value={settings.weight}
                  display={weightWord(settings.weight)}
                  onChange={(weight) => setSettings({ ...settings, weight })}
                />
                <Slider label="Stroke" min={0} max={4} step={0.5} value={settings.stroke} onChange={(stroke) => setSettings({ ...settings, stroke })} />
                <label className="grid gap-2 text-sm text-muted">
                  Upscale
                  <select
                    className="min-h-11 rounded-lg border border-line bg-card px-2 text-ink"
                    value={settings.upscale}
                    onChange={(event) => setSettings({ ...settings, upscale: Number(event.target.value) })}
                  >
                    <option value={1}>1× original</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                  </select>
                </label>
                <label className="grid gap-2 text-sm text-muted">
                  Scale look
                  <select
                    className="min-h-11 rounded-lg border border-line bg-card px-2 text-ink"
                    value={settings.scaleMethod}
                    onChange={(event) =>
                      setSettings({ ...settings, scaleMethod: event.target.value as TraceSettings["scaleMethod"] })
                    }
                  >
                    <option value="smooth">Smooth</option>
                    <option value="sharp">Sharp</option>
                    <option value="crisp">Crisp pixels</option>
                  </select>
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={settings.lineart}
                    onChange={(event) => setSettings({ ...settings, lineart: event.target.checked })}
                  />
                  Line art
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={settings.removeBg}
                    onChange={(event) => setSettings({ ...settings, removeBg: event.target.checked })}
                  />
                  Remove background
                </label>
                <Slider
                  label="Cut tolerance"
                  min={8}
                  max={80}
                  value={settings.tolerance}
                  onChange={(tolerance) => setSettings({ ...settings, tolerance })}
                />
              </div>
              <p className="mt-3 text-sm text-muted">
                Smooth takes the wobble out of curves. Line weight below 0 thins strokes. Leave Stroke at 0 — it only adds an outline, which makes lines fatter.
              </p>

              <div className="mt-4 border-t border-line pt-4">
                <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="font-display text-2xl font-medium">Magic layers</h2>
                    <p className="text-muted">Hide, recolor, or nudge each traced color.</p>
                  </div>
                  <button
                    type="button"
                    className="min-h-11 rounded-full border border-line px-4 font-semibold"
                    onClick={() =>
                      updateLayers(layers.map((layer) => ({ ...layer, visible: layer.role !== "background" })))
                    }
                  >
                    Subject only
                  </button>
                </div>
                <ol className="grid gap-2">
                  {layers.map((layer) => (
                    <li
                      key={layer.id}
                      className={"grid items-center gap-3 rounded-xl border border-line bg-card p-2 sm:grid-cols-[auto_auto_1fr_auto] " + (layer.visible ? "" : "opacity-45")}
                    >
                      <input
                        type="checkbox"
                        checked={layer.visible}
                        aria-label={"Show " + layer.name}
                        onChange={(event) =>
                          updateLayers(layers.map((item) => (item.id === layer.id ? { ...item, visible: event.target.checked } : item)))
                        }
                      />
                      <input
                        type="color"
                        className="size-8 rounded-md border border-line bg-card"
                        value={toHex(layer.fill)}
                        aria-label={"Recolor " + layer.name}
                        onChange={(event) =>
                          updateLayers(layers.map((item) => (item.id === layer.id ? { ...item, fill: event.target.value } : item)))
                        }
                      />
                      <div>
                        <p className="font-semibold">{layer.name}</p>
                        <p className="text-sm text-muted">
                          {layer.ds.length} paths{layer.role === "background" ? " · edge color" : ""}
                        </p>
                      </div>
                      <div className="flex gap-1">
                        <Nudge label="Up" onClick={() => nudge(layer.id, 0, -8)} />
                        <Nudge label="Down" onClick={() => nudge(layer.id, 0, 8)} />
                        <Nudge label="Left" onClick={() => nudge(layer.id, -8, 0)} />
                        <Nudge label="Right" onClick={() => nudge(layer.id, 8, 0)} />
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </section>

        {member || !memberReady ? null : (
        <section id="plans" className="mt-10">
          <p className="text-xs font-semibold tracking-widest text-field uppercase">Plans</p>
          <h2 className="font-display mt-2 text-4xl font-medium">Clean files, no watermark.</h2>
          <p className="mt-2 max-w-xl text-muted">
            The preview stays stamped so it can’t be lifted. A plan downloads the SVG without it.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Plan
              name="Monthly"
              price="$9.99"
              period="per month"
              busy={payBusy === "month"}
              onChoose={() => subscribe("month")}
            />
            <Plan
              name="Annual"
              price="$100"
              period="per year"
              busy={payBusy === "year"}
              onChoose={() => subscribe("year")}
            />
          </div>
          {payError ? <p className="mt-3 text-amber">{payError}</p> : null}
        </section>
        )}

        <section id="how" className="mt-10 grid gap-6 md:grid-cols-3">
          <article>
            <p className="font-display text-amber">01</p>
            <h2 className="font-display text-2xl">Pick</h2>
            <p className="text-muted">Click the drop area or drag a file onto the page. Logos trace cleaner than photos.</p>
          </article>
          <article>
            <p className="font-display text-amber">02</p>
            <h2 className="font-display text-2xl">Trace</h2>
            <p className="text-muted">Colors become separate layers you can hide, recolor, or move.</p>
          </article>
          <article>
            <p className="font-display text-amber">03</p>
            <h2 className="font-display text-2xl">Download</h2>
            <p className="text-muted">Members save a clean SVG and open it in Figma or Illustrator.</p>
          </article>
        </section>

        <section id="faq" className="mt-10 max-w-2xl">
          <p className="text-xs font-semibold tracking-widest text-field uppercase">Questions</p>
          <h2 className="font-display mt-2 text-4xl font-medium">Common questions</h2>
          <dl className="mt-6 grid gap-5">
            <div>
              <dt className="font-semibold">What files can I convert to SVG?</dt>
              <dd className="mt-1 text-muted">
                PNG, JPG, WebP, GIF, and BMP. Logos and flat illustrations trace cleaner than photos.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Will the SVG open in Illustrator or Figma?</dt>
              <dd className="mt-1 text-muted">
                Yes. Colors become layers you can hide, recolor, or move, then download as a clean SVG.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Why is the preview watermarked?</dt>
              <dd className="mt-1 text-muted">
                The preview is stamped so it cannot be copied out. A plan downloads the file without the watermark. Monthly
                is $9.99 and a year is $100.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">Where does the tracing happen?</dt>
              <dd className="mt-1 text-muted">In your browser. The artwork is not uploaded to make the SVG.</dd>
            </div>
          </dl>
        </section>

        <section id="contact" className="mt-10 max-w-xl">
          <p className="text-xs font-semibold tracking-widest text-field uppercase">Contact</p>
          <h2 className="font-display mt-2 text-4xl font-medium">Contact us</h2>
          <p className="mt-2 text-muted">Questions about a trace, a plan, or a file? Send a note and we’ll reply.</p>
          <a
            href="mailto:info@vectorlineform.com"
            className="mt-4 inline-flex min-h-11 items-center font-semibold text-field"
          >
            info@vectorlineform.com
          </a>
        </section>
      </main>

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-field/80 text-cream">
          <p className="font-display text-4xl">Drop to trace</p>
        </div>
      ) : null}
    </div>
  );

  function subscribe(plan: "month" | "year") {
    setPayError("");
    if (!user) {
      window.location.href = "/login";
      return;
    }
    setPayBusy(plan);
    startCheckout({ data: { plan, origin: window.location.origin } })
      .then((result) => {
        window.location.href = result.url;
      })
      .catch((err: unknown) => {
        setPayBusy("");
        setPayError(err instanceof Error ? err.message : "Checkout could not start.");
      });
  }

  function nudge(id: number, x: number, y: number) {
    updateLayers(layers.map((layer) => (layer.id === id ? { ...layer, dx: layer.dx + x, dy: layer.dy + y } : layer)));
  }
}

function SiteHeader({ member }: { member: boolean }) {
  const [open, setOpen] = useState(false);
  const links = [
    ...(member ? [] : [{ href: "#plans", label: "Pricing" }]),
    { href: "#how", label: "How it works" },
    { href: "#contact", label: "Contact" },
  ];

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {open ? (
        <button type="button" aria-label="Close menu" className="fixed inset-0 z-30 bg-ink/25 md:hidden" onClick={() => setOpen(false)} />
      ) : null}
      <header className="sticky top-0 z-40 bg-paper/95 backdrop-blur">
        <div className="flex items-center justify-between gap-3 px-5 py-3 sm:px-10">
          <a href="#studio" className="flex min-w-0 items-center gap-2.5 font-display text-xl font-semibold text-ink">
            <img src="/logo-mark.svg" alt="" width={28} height={28} className="shrink-0" />
            Lineform
          </a>
          <nav className="hidden items-center gap-1 md:flex" aria-label="Site">
            {links.map((link) => (
              <a key={link.href} href={link.href} className="inline-flex min-h-11 items-center rounded-full px-3 text-muted hover:text-ink">
                {link.label}
              </a>
            ))}
            <AccountSlot />
          </nav>
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-line md:hidden"
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
        {open ? (
          <nav id="site-menu" aria-label="Site" className="absolute inset-x-0 top-full border-b border-line bg-paper px-3 py-2 shadow-lg md:hidden">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="flex min-h-12 items-center rounded-xl px-3 text-base text-ink"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <div className="mt-1 border-t border-line px-3 py-3">
              <AccountSlot />
            </div>
          </nav>
        ) : null}
      </header>
    </>
  );
}

function clampFocal(value: number, zoom: number) {
  if (zoom <= 1) return 0.5;
  const half = 0.5 / zoom;
  return Math.min(1 - half, Math.max(half, value));
}

function VectorZoom({ svg, src, busy }: { svg: string; src: string; busy: boolean }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const sharp = useRef(false);
  const baseRef = useRef({ w: 0, h: 0 });
  const zoomRef = useRef(1);
  const [view, setView] = useState({ zoom: 1, fx: 0.5, fy: 0.5 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [panning, setPanning] = useState(false);
  const [lens, setLens] = useState<{ x: number; y: number; relX: number; relY: number; artW: number; artH: number } | null>(null);
  sharp.current = Boolean(svg);
  zoomRef.current = view.zoom;
  const maxZoom = svg ? 6 : 3;

  useEffect(() => {
    setView({ zoom: 1, fx: 0.5, fy: 0.5 });
    setLens(null);
    setBox({ w: 0, h: 0 });
    baseRef.current = { w: 0, h: 0 };
  }, [svg, src]);

  useEffect(() => {
    const art = artRef.current;
    if (!art) return;
    const measure = () => {
      if (zoomRef.current !== 1) return;
      const w = art.offsetWidth;
      const h = art.offsetHeight;
      if (w < 8 || h < 8) return;
      baseRef.current = { w, h };
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(art);
    return () => observer.disconnect();
  }, [svg, src, busy]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const art = artRef.current;
      if (!art) return;
      const dir = event.deltaY < 0 ? 1 : -1;
      setView((current) => {
        const cap = sharp.current ? 6 : 3;
        const next = Math.min(cap, Math.max(1, Math.round(current.zoom * (dir > 0 ? 1.12 : 0.89) * 100) / 100));
        if (next === current.zoom) return current;
        if (next === 1) return { zoom: 1, fx: 0.5, fy: 0.5 };
        const w = baseRef.current.w || art.offsetWidth || 1;
        const h = baseRef.current.h || art.offsetHeight || 1;
        const centerX = frame.getBoundingClientRect().left + art.offsetLeft + art.offsetWidth / 2;
        const centerY = frame.getBoundingClientRect().top + art.offsetTop + art.offsetHeight / 2;
        const cx = event.clientX - centerX;
        const cy = event.clientY - centerY;
        return {
          zoom: next,
          fx: clampFocal(current.fx + (cx / w) * (1 / current.zoom - 1 / next), next),
          fy: clampFocal(current.fy + (cy / h) * (1 / current.zoom - 1 / next), next),
        };
      });
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  function artwork(box?: { w: number }) {
    if (svg) {
      return (
        <div
          className={box ? "[&_svg]:block [&_svg]:h-auto [&_svg]:w-full" : "[&_svg]:block [&_svg]:h-auto [&_svg]:max-h-96 [&_svg]:w-auto [&_svg]:max-w-full"}
          style={box ? { width: box.w } : undefined}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      );
    }
    if (!src) return null;
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        className={box ? "block h-auto max-w-none" : "block max-h-96 max-w-full"}
        style={box ? { width: box.w } : undefined}
      />
    );
  }

  function hideLens() {
    setLens(null);
  }

  function moveLens(event: React.PointerEvent) {
    if (event.pointerType !== "mouse" || view.zoom !== 1 || busy) {
      hideLens();
      return;
    }
    const art = artRef.current;
    const wrap = wrapRef.current;
    if (!art || !wrap) return;
    const artBox = art.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    if (!artBox.width || !artBox.height) return;
    const relX = (event.clientX - artBox.left) / artBox.width;
    const relY = (event.clientY - artBox.top) / artBox.height;
    if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
      hideLens();
      return;
    }
    const size = 176;
    const left = Math.min(Math.max(8, event.clientX - wrapBox.left - size / 2), Math.max(8, wrapBox.width - size - 8));
    const top = Math.min(Math.max(8, event.clientY - wrapBox.top - size / 2), Math.max(8, wrapBox.height - size - 8));
    setLens({ x: left, y: top, relX, relY, artW: art.offsetWidth, artH: art.offsetHeight });
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 || view.zoom > 1) event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size >= 2) {
      const pts = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, zoom: view.zoom };
      hideLens();
      return;
    }
    if (view.zoom > 1) setPanning(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) {
      moveLens(event);
      return;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2 && pinch.current) {
      const pts = [...pointers.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const next = Math.min(maxZoom, Math.max(1, Math.round(pinch.current.zoom * (dist / pinch.current.dist) * 100) / 100));
      setView((current) => (next === 1 ? { zoom: 1, fx: 0.5, fy: 0.5 } : { ...current, zoom: next }));
      hideLens();
      return;
    }
    if (view.zoom <= 1) {
      moveLens(event);
      return;
    }
    const w = baseRef.current.w || 1;
    const h = baseRef.current.h || 1;
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    setView((current) => ({
      ...current,
      fx: clampFocal(current.fx - dx / (w * current.zoom), current.zoom),
      fy: clampFocal(current.fy - dy / (h * current.zoom), current.zoom),
    }));
    hideLens();
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setPanning(false);
  }

  function zoomBy(dir: 1 | -1) {
    const steps = [1, 1.5, 2, 3, 4, 6].filter((step) => step <= maxZoom);
    setView((current) => {
      const index = steps.findIndex((step) => step >= current.zoom - 0.01);
      const next = steps[Math.min(steps.length - 1, Math.max(0, (index === -1 ? 0 : index) + dir))];
      if (!next || next === 1) return { zoom: 1, fx: 0.5, fy: 0.5 };
      return { zoom: next, fx: current.fx, fy: current.fy };
    });
    hideLens();
  }

  const tx = -(view.fx - 0.5) * box.w * view.zoom;
  const ty = -(view.fy - 0.5) * box.h * view.zoom;
  const lensSize = 176;
  const mag = 3;

  return (
    <figure className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <figcaption className="text-xs tracking-widest text-muted uppercase">Vectors</figcaption>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Zoom out"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-line text-lg disabled:opacity-40"
            disabled={view.zoom <= 1}
            onClick={() => zoomBy(-1)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            className="inline-flex min-h-11 min-w-14 items-center justify-center rounded-full border border-line px-2 text-sm font-semibold"
            onClick={() => setView({ zoom: 1, fx: 0.5, fy: 0.5 })}
          >
            {Math.round(view.zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-line text-lg disabled:opacity-40"
            disabled={view.zoom >= maxZoom}
            onClick={() => zoomBy(1)}
          >
            +
          </button>
        </div>
      </div>
      <div ref={wrapRef} className="relative">
        <div
          ref={frameRef}
          className="relative grid min-h-72 w-full min-w-0 place-items-center overflow-hidden rounded-2xl border border-line bg-paper p-4 select-none"
          style={{ touchAction: "none", cursor: panning ? "grabbing" : view.zoom > 1 ? "grab" : "zoom-in" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse" && pointers.current.size === 0) hideLens();
          }}
          onDoubleClick={() => {
            setView((current) => (current.zoom > 1 ? { zoom: 1, fx: 0.5, fy: 0.5 } : { zoom: Math.min(3, maxZoom), fx: 0.5, fy: 0.5 }));
            hideLens();
          }}
        >
          <div
            ref={artRef}
            className={view.zoom > 1 && box.w ? "min-w-0 justify-self-center" : "w-fit max-w-full"}
            style={{
              width: view.zoom > 1 && box.w ? box.w * view.zoom : undefined,
              transform: `translate(${tx}px, ${ty}px)`,
            }}
          >
            {artwork(view.zoom > 1 && box.w ? { w: box.w * view.zoom } : undefined)}
          </div>
          {busy ? (
            <p className="absolute inset-0 grid place-items-center bg-card/70 font-display text-xl">Tracing paths…</p>
          ) : null}
        </div>
        {lens && lens.artW > 8 ? (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 overflow-hidden rounded-full border-2 border-cream bg-paper shadow-[0_12px_40px_rgba(27,25,20,0.28)]"
            style={{ width: lensSize, height: lensSize, left: lens.x, top: lens.y }}
          >
            <div
              style={{
                width: lens.artW * mag,
                transform: `translate(${lensSize / 2 - lens.relX * lens.artW * mag}px, ${lensSize / 2 - lens.relY * lens.artH * mag}px)`,
              }}
            >
              {artwork({ w: lens.artW * mag })}
            </div>
            <div className="absolute top-1/2 left-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-ink/40" />
            <div className="absolute top-1/2 left-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-ink/40" />
            <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-cream">
              3×
            </span>
          </div>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted">Hover, scroll, or pinch to look closer. The paths stay sharp.</p>
    </figure>
  );
}

function AccountSlot() {
  const { isPending } = useCurrentUserState();
  if (isPending) return <div className="h-11 w-24 animate-pulse rounded-full bg-line" />;
  return (
    <>
      <SignedOut>
        <a href="/login" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 font-semibold">
          Sign in
        </a>
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </>
  );
}

function Plan({
  name,
  price,
  period,
  busy,
  onChoose,
}: {
  name: string;
  price: string;
  period: string;
  busy: boolean;
  onChoose: () => void;
}) {
  return (
    <article className="rounded-3xl border border-line bg-card p-6 shadow-lg">
      <h3 className="font-display text-2xl">{name}</h3>
      <p className="mt-3">
        <span className="font-display text-5xl font-medium">{price}</span>{" "}
        <span className="text-muted">{period}</span>
      </p>
      <ul className="mt-4 space-y-1 text-muted">
        <li>Watermark removed from the download</li>
        <li>Clean SVG and cutout PNG</li>
        <li>Cancel any time</li>
      </ul>
      <button
        type="button"
        className="mt-6 min-h-11 rounded-full bg-field px-5 font-semibold text-cream disabled:opacity-40"
        disabled={busy}
        onClick={onChoose}
      >
        {busy ? "Opening checkout…" : `Choose ${name.toLowerCase()}`}
      </button>
    </article>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 text-sm text-muted">
      <span>
        {label} <strong className="text-ink">{display ?? value}</strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function weightWord(weight: number) {
  if (weight <= -1.5) return "Hairline " + weight;
  if (weight < 0) return "Thin " + weight;
  if (weight === 0) return "Normal";
  if (weight >= 1.5) return "Thick " + weight;
  return "Medium " + weight;
}

function Nudge({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="min-h-11 min-w-11 rounded-lg border border-line bg-paper" onClick={onClick}>
      {label === "Up" ? "↑" : label === "Down" ? "↓" : label === "Left" ? "←" : "→"}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function loadHtmlImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = url;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function baseName(name: string) {
  return (name || "trace").replace(/\.\w+$/, "");
}
