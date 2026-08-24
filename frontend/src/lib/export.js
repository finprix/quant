export function toCsv(columns, rows) {
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
    return text;
  };
  const header = columns.map((column) => escape(column.label)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => {
      const value = column.value ? column.value(row) : row[column.key];
      return escape(value);
    }).join(","),
  );
  return [header, ...body].join("\r\n");
}

export function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename, columns, rows) {
  downloadText(filename, toCsv(columns, rows));
}

let pngWarningShown = false;

export async function downloadNodeAsPng(node, filename, options = {}) {
  if (!node) return;
  try {
    const { toPng } = await import("html-to-image");
    const dataUrl = await toPng(node, {
      backgroundColor: options.background || "#0a0d12",
      pixelRatio: 2,
      cacheBust: true,
    });
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } catch (error) {
    if (!pngWarningShown) {
      pngWarningShown = true;
      // eslint-disable-next-line no-console
      console.warn("PNG export failed:", error);
    }
    throw error;
  }
}
