export function stampPreview(svg: string, width: number, height: number) {
  return new Promise<string>((resolve) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const max = 900;
      const scale = Math.min(1, max / Math.max(width, height, 1));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve("");
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-0.45);
      const size = Math.max(22, Math.round(canvas.width / 14));
      ctx.font = `700 ${size}px sans-serif`;
      ctx.fillStyle = "rgba(28, 27, 25, 0.22)";
      ctx.textAlign = "center";
      const stepY = size * 4.2;
      const stepX = size * 7;
      for (let y = -canvas.height; y < canvas.height; y += stepY) {
        for (let x = -canvas.width; x < canvas.width; x += stepX) {
          ctx.fillText("LINEFORM", x, y);
        }
      }
      ctx.restore();
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("");
    };
    img.src = url;
  });
}
