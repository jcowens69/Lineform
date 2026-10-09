import { inflateSync } from "node:zlib";

export type VersaJob = {
  name: string;
  printer: "ty300" | "vg3";
  width: number;
  height: number;
  dpi: number;
  jpeg: Uint8Array;
  alpha?: Uint8Array;
  white?: Uint8Array;
  cut?: string;
  ring?: string;
  padPx?: number;
};

const PATH = /^[\d\s.mleh-]+$/i;

export function buildVersaWorksPdf(job: VersaJob) {
  if (job.width < 1 || job.height < 1 || job.width > 2000 || job.height > 2000) throw new Error("That art is too large to export.");
  if (job.dpi < 72 || job.dpi > 600) throw new Error("Unexpected print size.");
  if (job.jpeg.length < 32 || job.jpeg.length > 4_000_000) throw new Error("The color image is too large.");
  const jpegSize = readJpegSize(job.jpeg);
  if (!jpegSize || jpegSize.w !== job.width || jpegSize.h !== job.height) throw new Error("The color image does not match the art.");
  if (job.alpha) inflateChecked(job.alpha, job.width * job.height, "color mask");
  if (job.white) inflateChecked(job.white, job.width * job.height, "white plate");
  const cut = cleanPath(job.cut);
  const ring = cleanPath(job.ring);
  const pad = Math.max(0, job.padPx ?? 0);
  if (pad > job.dpi) throw new Error("Unexpected border.");
  const pageW = ((job.width + pad * 2) * 72) / job.dpi;
  const pageH = ((job.height + pad * 2) * 72) / job.dpi;
  const imageW = (job.width * 72) / job.dpi;
  const imageH = (job.height * 72) / job.dpi;
  const origin = (pad * 72) / job.dpi;
  const wantWhite = Boolean(job.white) || Boolean(ring);
  const wantCut = Boolean(cut);

  let id = 1;
  const catalogId = id++;
  const pagesId = id++;
  const pageId = id++;
  const contentId = id++;
  const gsId = id++;
  const whiteFn = wantWhite ? id++ : 0;
  const cutFn = wantCut ? id++ : 0;
  const maskId = job.alpha ? id++ : 0;
  const colorId = id++;
  const whiteId = job.white ? id++ : 0;

  const commands: string[] = [
    "q",
    `${n(imageW)} 0 0 ${n(imageH)} ${n(origin)} ${n(origin)} cm`,
    "/ImC Do",
    "Q",
  ];
  if (ring && whiteFn) commands.push("q", "/GS0 gs", "0 0 0 0 k", ring, "f*", "/CSW cs", "1 scn", ring, "f*", "Q");
  if (whiteId) {
    commands.push("q", "/GS0 gs", `${n(imageW)} 0 0 ${n(imageH)} ${n(origin)} ${n(origin)} cm`, "/ImW Do", "Q");
  }
  if (cut && cutFn) commands.push("q", "/GS0 gs", "/CSC CS", "1 SCN", "0.25 w", "1 J", "1 j", cut, "S", "Q");
  const content = Buffer.from(commands.join("\n"));

  const objects: Buffer[] = [];
  const put = (body: Buffer | string) => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
  };
  put(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  put(`<< /Type /Pages /Count 1 /Kids [${pageId} 0 R] >>`);
  const xobjects = [`/ImC ${colorId} 0 R`];
  if (whiteId) xobjects.push(`/ImW ${whiteId} 0 R`);
  const spaces: string[] = [];
  if (whiteFn) spaces.push(`/CSW [/Separation /RDG_WHITE /DeviceCMYK ${whiteFn} 0 R]`);
  if (cutFn) spaces.push(`/CSC [/Separation /CutContour /DeviceCMYK ${cutFn} 0 R]`);
  put(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] /Contents ${contentId} 0 R /Resources << /XObject << ${xobjects.join(" ")} >> /ExtGState << /GS0 ${gsId} 0 R >> /ColorSpace << ${spaces.join(" ")} >> >> >>`,
  );
  put(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]));
  put("<< /Type /ExtGState /OP true /op true /OPM 1 >>");
  if (whiteFn) put("<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 0] /N 1 >>");
  if (cutFn) put("<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>");
  if (maskId && job.alpha) put(flateImage(job.alpha, job.width, job.height, "/DeviceGray"));
  put(jpegStream(job.jpeg, job.width, job.height, maskId));
  if (whiteId && job.white && whiteFn) {
    put(flateImage(job.white, job.width, job.height, `[/Separation /RDG_WHITE /DeviceCMYK ${whiteFn} 0 R]`));
  }
  if (objects.length !== id - 1) throw new Error("Could not build the PDF.");
  return assemble(objects);
}

function jpegStream(jpeg: Uint8Array, w: number, h: number, maskId: number) {
  const mask = maskId ? ` /SMask ${maskId} 0 R` : "";
  return Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length}${mask} >>\nstream\n`,
    ),
    jpeg,
    Buffer.from("\nendstream"),
  ]);
}

function flateImage(data: Uint8Array, w: number, h: number, space: string) {
  return Buffer.concat([
    Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${space} /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    ),
    data,
    Buffer.from("\nendstream"),
  ]);
}

function assemble(objects: Buffer[]) {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets = [0];
  let pos = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(pos);
    const head = Buffer.from(`${index + 1} 0 obj\n`);
    const tail = Buffer.from("\nendobj\n");
    chunks.push(head, body, tail);
    pos += head.length + body.length + tail.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}

function inflateChecked(data: Uint8Array, expected: number, label: string) {
  if (data.length > Math.max(65536, expected + 1024)) throw new Error(`The ${label} is too large.`);
  let raw: Buffer;
  try {
    raw = inflateSync(data, { maxOutputLength: expected });
  } catch {
    throw new Error(`The ${label} could not be read.`);
  }
  if (raw.length !== expected) throw new Error(`The ${label} does not match the art.`);
}

function cleanPath(path: string | undefined) {
  if (!path?.trim()) return "";
  const compact = path.trim();
  if (compact.length > 600000 || !PATH.test(compact)) throw new Error("The cut path is not valid.");
  return compact;
}

function readJpegSize(jpeg: Uint8Array) {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const size = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: (jpeg[i + 5] << 8) | jpeg[i + 6], w: (jpeg[i + 7] << 8) | jpeg[i + 8] };
    }
    if (size < 2) return null;
    i += 2 + size;
  }
  return null;
}

function n(value: number) {
  return (Math.round(value * 100) / 100).toString();
}
