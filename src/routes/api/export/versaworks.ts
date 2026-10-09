import { createFileRoute } from "@tanstack/react-router";
import type { VersaJob } from "@/lib/versaworks-pdf.server";

const MAX_BODY = 4_500_000;

export const Route = createFileRoute("/api/export/versaworks")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const site = request.headers.get("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") {
          return json({ error: "Forbidden" }, 403);
        }
        const length = Number(request.headers.get("content-length") || 0);
        if (length > MAX_BODY) return json({ error: "That art is too large to export." }, 413);
        const session = await (await import("@/lib/auth/server")).auth.api.getSession({ headers: request.headers });
        const userId = session?.user?.id;
        if (!userId) return json({ error: "Sign in to download a print file." }, 401);
        const { getSql } = await import("@/lib/db");
        const sql = await getSql();
        const rows = await sql<{ plan: string }>`
          select plan from subscriptions
          where user_id = ${userId}
            and status = 'active'
            and current_period_end > now()
          limit 1
        `;
        const plan = rows[0]?.plan;
        if (plan !== "month" && plan !== "year") {
          return json({ error: "A membership is required for print files." }, 402);
        }
        const raw = await request.text();
        if (raw.length > MAX_BODY) return json({ error: "That art is too large to export." }, 413);
        let input: unknown;
        try {
          input = JSON.parse(raw);
        } catch {
          return json({ error: "The print file could not be built." }, 400);
        }
        try {
          const job = jobFrom(input);
          const { buildVersaWorksPdf } = await import("@/lib/versaworks-pdf.server");
          const pdf = buildVersaWorksPdf(job);
          return new Response(new Uint8Array(pdf), {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `attachment; filename="${job.name}-versaworks.pdf"`,
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "The print file could not be built.";
          return json({ error: message }, 400);
        }
      },
    },
  },
});

function jobFrom(input: unknown): VersaJob {
  const body = input as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new Error("The print file could not be built.");
  const printer = body.printer === "vg3" ? "vg3" : body.printer === "ty300" ? "ty300" : "";
  if (!printer) throw new Error("Pick a printer.");
  const width = whole(body.width, "width");
  const height = whole(body.height, "height");
  if (typeof body.dpi !== "number" || !Number.isFinite(body.dpi)) throw new Error("Unexpected print size.");
  const padPx = body.padPx == null ? 0 : Number(body.padPx);
  if (!Number.isFinite(padPx) || padPx < 0) throw new Error("Unexpected border.");
  const cut = text(body.cut);
  const ring = text(body.ring);
  if (printer === "ty300" && !body.white) throw new Error("A white plate is required.");
  if (printer === "vg3" && !cut) throw new Error("A cut path is required.");
  if (printer === "vg3" && padPx > 0 && !ring) throw new Error("A white border is required.");
  return {
    name: safeName(body.name),
    printer,
    width,
    height,
    dpi: body.dpi,
    jpeg: bytes(body.jpeg, "color image"),
    alpha: bytes(body.alpha, "color mask"),
    white: printer === "ty300" ? bytes(body.white, "white plate") : undefined,
    cut: printer === "vg3" ? cut : undefined,
    ring: printer === "vg3" && padPx > 0 ? ring : undefined,
    padPx: printer === "vg3" ? padPx : 0,
  };
}

function whole(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Unexpected ${label}.`);
  return value;
}

function text(value: unknown) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("The cut path is not valid.");
  return value;
}

function bytes(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${label}.`);
  if (value.length > 4_000_000) throw new Error(`The ${label} is too large.`);
  const buf = Buffer.from(value, "base64");
  if (!buf.length) throw new Error(`Missing ${label}.`);
  return buf;
}

function safeName(value: unknown) {
  const clean = String(value ?? "lineform")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "lineform";
}

function json(body: { error: string }, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
