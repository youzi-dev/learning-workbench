import React, { useEffect, useRef, useState } from "react";
import type { LocalFileRef } from "../../workbench/contracts/files";
import type { ResourcePort } from "../../workbench/contracts/resources";
import type { LibraryWorkflow } from "./workflow";
import type { ReadingState } from "./reading-state";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
/** Bounded range transport: never allocate a whole large document in the UI. */
export function createPdfRangeTransport(
  file: LocalFileRef,
  resources: ResourcePort,
  onError: (error: unknown) => void,
) {
  const transport = new pdfjs.PDFDataRangeTransport(
    file.size,
    new Uint8Array(),
    false,
  );
  let closed = false;
  transport.requestDataRange = (begin: number, end: number) => {
    void (async () => {
      for (let offset = begin; offset < end; offset += 1024 * 1024) {
        if (closed) return;
        const length = Math.min(1024 * 1024, end - offset),
          bytes = await resources.read(file, offset, length);
        if (bytes.byteLength !== length)
          throw Error("PDF 文件不完整，请重新下载");
        if (!closed) transport.onDataRange(offset, bytes);
      }
    })().catch((error) => {
      if (!closed) onError(error);
    });
  };
  transport.abort = () => {
    closed = true;
  };
  return transport;
}
export function PdfReader({
  assetId,
  file,
  resources,
  workflow,
}: {
  assetId: string;
  file: LocalFileRef;
  resources: ResourcePort;
  workflow: LibraryWorkflow;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    documentRef = useRef<pdfjs.PDFDocumentProxy | null>(null),
    saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [state, setState] = useState<ReadingState>({
      assetId,
      page: 1,
      bookmarks: [],
    }),
    [pages, setPages] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const update = (next: ReadingState) => {
    setState(next);
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => workflow.saveReadingState(next))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "阅读位置未保存"),
      );
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const range = createPdfRangeTransport(file, resources, (cause) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : "PDF 读取失败");
        setLoading(false);
      }
    });
    const task = pdfjs.getDocument({
      range,
      rangeChunkSize: 65536,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      useSystemFonts: true,
    });
    void Promise.all([task.promise, workflow.readingState(assetId)])
      .then(([doc, saved]) => {
        if (!active) {
          void task.destroy();
          return;
        }
        documentRef.current = doc;
        setPages(doc.numPages);
        setState({ ...saved, page: Math.min(saved.page, doc.numPages) });
        setLoading(false);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "PDF 无法打开");
          setLoading(false);
        }
      });
    return () => {
      active = false;
      range.abort();
      documentRef.current = null;
      void task.destroy();
    };
  }, [assetId, file.token, resources, workflow]);
  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || !canvas.current) return;
    let active = true,
      renderTask: pdfjs.RenderTask | undefined;
    void doc
      .getPage(state.page)
      .then((page) => {
        if (!active || !canvas.current) return;
        const base = page.getViewport({ scale: 1 }),
          width = Math.min(
            canvas.current.parentElement?.clientWidth || 760,
            960,
          ),
          viewport = page.getViewport({
            scale: Math.min(2, width / base.width),
          }),
          pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
        const target = canvas.current;
        target.width = Math.ceil(viewport.width * pixelRatio);
        target.height = Math.ceil(viewport.height * pixelRatio);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvas: target,
          viewport,
          transform:
            pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        return renderTask.promise;
      })
      .catch((cause) => {
        if (active && cause?.name !== "RenderingCancelledException")
          setError("此页绘制失败，请重试或保存文件后打开");
      });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [state.page, pages]);
  return (
    <section className="wb-pdf" aria-label="PDF 阅读器">
      <div className="wb-reader-controls">
        <button
          disabled={loading || state.page <= 1}
          onClick={() => update({ ...state, page: state.page - 1 })}
        >
          上一页
        </button>
        <label>
          页码
          <input
            type="number"
            aria-label="PDF 页码"
            min={1}
            max={pages || 1}
            value={state.page}
            disabled={!pages}
            onChange={(e) => {
              const page = Number(e.target.value);
              if (Number.isInteger(page) && page > 0 && page <= pages)
                update({ ...state, page });
            }}
          />
        </label>
        <span>/ {pages || "…"}</span>
        <button
          disabled={loading || state.page >= pages}
          onClick={() => update({ ...state, page: state.page + 1 })}
        >
          下一页
        </button>
        <button
          disabled={!pages}
          aria-pressed={state.bookmarks.includes(state.page)}
          onClick={() =>
            update({
              ...state,
              bookmarks: state.bookmarks.includes(state.page)
                ? state.bookmarks.filter((p) => p !== state.page)
                : [...state.bookmarks, state.page].sort((a, b) => a - b),
            })
          }
        >
          {state.bookmarks.includes(state.page) ? "移除书签" : "添加书签"}
        </button>
      </div>
      {state.bookmarks.length > 0 && (
        <div className="wb-actions" aria-label="阅读书签">
          {state.bookmarks.map((page) => (
            <button
              key={page}
              onClick={() =>
                update({ ...state, page: Math.min(page, pages || page) })
              }
            >
              第 {page} 页
            </button>
          ))}
        </div>
      )}
      {loading && <p role="status">正在读取 PDF…</p>}
      {error && (
        <p role="alert" className="wb-notice">
          {error}
        </p>
      )}
      <canvas ref={canvas} aria-label={`PDF 第 ${state.page} 页`} />
      <small>阅读位置与书签自动保存。文档中的脚本与外链不会自动执行。</small>
    </section>
  );
}
