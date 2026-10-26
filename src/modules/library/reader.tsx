import React, { useEffect, useState, useRef } from "react";
import type { Entity } from "../../workbench/contracts/data";
import type { Asset } from "./model";
import type { ResourcePreview } from "../../workbench/contracts/resources";
import type { LibraryWorkflow } from "./workflow";
import { descriptor } from "./workflow";
import { PdfReader } from "./pdf-reader";
type Opened = Awaited<ReturnType<LibraryWorkflow["openAsset"]>>;
export function AssetReader({
  entry,
  workflow,
}: {
  entry: Entity<Asset>;
  workflow: LibraryWorkflow;
}) {
  const [opened, setOpened] = useState<Opened | null>(null),
    [preview, setPreview] = useState<ResourcePreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0),
    [decodeFailed, setDecodeFailed] = useState(false);
  const resources = workflow.context.platform.resources;
  const [captureState, setCaptureState] = useState<import('../../workbench/files/capture-intents').CaptureIntent | null>(null), [replacementUrl, setReplacementUrl] = useState('');
  const generation = useRef(0), previewRef = useRef<ResourcePreview | null>(null);
  const [closed, setClosed] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!resources) return;
    let active = true;
    const refresh = () => {void resources.capture.status(entry.id).then(value => {if (active) setCaptureState(value);}).catch(() => {});};
    refresh(); const unsubscribe = workflow.context.subscribe(refresh); const timer = setInterval(refresh, 2000);
    return () => {active = false; unsubscribe(); clearInterval(timer);};
  }, [entry.id, resources, workflow]);
  useEffect(() => {
    const request = ++generation.current;
    let active = true,
      owned: ResourcePreview | undefined;
    setClosed(false);
    setNotice('');
    setOpened(null);
    setPreview(null);
    setError("");
    setDecodeFailed(false);
    void workflow
      .openAsset(entry.id)
      .then(async (result) => {
        if (!active || request !== generation.current) return;
        setOpened(result);
        if (result.file && resources && result.state !== "unsupported-format") {
          owned = await resources.preview(result.file);
          if (active && request === generation.current) {previewRef.current = owned; setPreview(owned);}
          else await owned.release();
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "资料打开失败");
      });
    return () => {
      active = false; generation.current++; previewRef.current = null;
      if (owned) void owned.release();
    };
  }, [entry.id, entry.payload.sha256, resources, workflow, attempt]);
  const action = async (work: (current: () => boolean) => Promise<void>, success: string) => {
    const request = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {await work(() => request === generation.current); if (request === generation.current) setNotice(success);}
    catch (cause) {if (request === generation.current) setError(cause instanceof Error ? cause.message : '操作未完成');}
    finally {if (request === generation.current) setBusy(false);}
  };
  const remove = async () => {
    const file = descriptor(entry.payload);
    if (!resources || !file) return;
    // Invalidate every pending open before releasing the actual preview lease.
    generation.current++; setClosed(true); setPreview(null);
    const current = previewRef.current; previewRef.current = null;
    await action(async isCurrent => {
      await current?.release(); await resources.removeLocal(entry.id, file);
      if (isCurrent()) setOpened({...opened!, file: null, localState: undefined, state: 'offline-missing'});
    }, '已移除本机下载，云端原件和资料记录仍保留');
  };
  const download = async () => {
    const request = generation.current;
    const file = descriptor(entry.payload);
    if (!resources || !file) return;
    setBusy(true);
    setError("");
    try {
      await resources.ensureLocal(entry.id, file);
      if (request === generation.current) setAttempt((n) => n + 1);
    } catch (cause) {
      if (request === generation.current) setError(
        cause instanceof Error ? cause.message : "文件尚未下载，请联网后重试",
      );
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };
  return (
    <section className="wb-asset-reader" aria-label="资料阅读">
      <h3>阅读资料</h3>
      {captureState?.state === 'waiting' && <p role="status">待联网 / 等待连接服务。资料目录已保存，连接后自动获取。</p>}
      {captureState?.state === 'needs-input' && <div><p role="status">临时网址授权已过期或不可用，请重新提供链接。资料用途和关联仍保留。</p><label>重新提供链接<input value={replacementUrl} onChange={event => setReplacementUrl(event.target.value)}/></label><button disabled={busy || !replacementUrl.trim()} onClick={() => void action(async () => {await resources!.capture.enqueue(entry.id, replacementUrl); setReplacementUrl(''); await resources!.capture.flush(); setCaptureState(await resources!.capture.status(entry.id));}, '已保留获取请求')}>重新提供链接并获取</button></div>}
      {!opened && !error && <p role="status">正在检查本机文件…</p>}
      {opened?.state === "link-only" && (
        <p>目前仅保留原链接，还没有已获取的文件。</p>
      )}
      {opened?.state === "offline-missing" && (
        <p role="status">
          此设备没有缓存文件。联网下载后即可阅读；目录与用途已保留。
        </p>
      )}
      {opened?.state === "unsupported-format" && (
        <p>
          {entry.payload.mime === "application/epub+zip"
            ? "EPUB 已保留，请保存到设备后用电子书应用打开。"
            : "此格式暂不支持内置阅读，可保存后用其他应用打开。"}
        </p>
      )}
      {opened?.localState === "staged" && entry.payload.availability !== "available" && (
        <p className="wb-saved">原件已安全保存在本机，等待上传核对。</p>
      )}
      {!closed && opened?.file &&
        entry.payload.mime === "application/pdf" &&
        resources && (
          <PdfReader
            assetId={entry.id}
            file={opened.file}
            resources={resources}
            workflow={workflow}
          />
        )}
      {preview && entry.payload.mime?.startsWith("image/") && !decodeFailed && (
        <img
          src={preview.url}
          alt={entry.payload.title}
          onError={() => setDecodeFailed(true)}
        />
      )}{" "}
      {preview && entry.payload.mime?.startsWith("video/") && !decodeFailed && (
        <video
          src={preview.url}
          controls
          preload="metadata"
          onError={() => setDecodeFailed(true)}
        />
      )}
      {decodeFailed && (
        <p role="alert">
          当前设备无法解码这份文件，请保存后用支持该格式的应用打开。
        </p>
      )}
      {opened && !opened.file && descriptor(entry.payload) && (
        <button disabled={busy || !resources} onClick={() => void download()}>
          {busy ? "正在下载并校验…" : "下载到本机"}
        </button>
      )}
      <div className="wb-actions">
        {opened?.file && resources && <button disabled={busy} onClick={() => void action(() => resources.exportFile(opened.file!, entry.payload.title), '已交给设备保存流程')}>保存文件后用其他应用打开</button>}
        {opened?.localState === 'cached' && resources && <>
          <button disabled={busy} onClick={() => void action(async isCurrent => {await resources.setPinned(entry.id, descriptor(entry.payload)!, !opened.pinned); if (isCurrent()) setOpened({...opened, pinned: !opened.pinned});}, opened.pinned ? '已取消离线保留' : '已离线保留')}>{opened.pinned ? '取消离线保留' : '离线保留'}</button>
          <button disabled={busy} onClick={() => void remove()}>移除本机下载</button>
        </>}
      </div>
      {opened?.pinned && <p role="status">此文件已离线保留</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="wb-notice">
          {error}
        </p>
      )}
      {error && (
        <button onClick={() => setAttempt((n) => n + 1)}>重新检查</button>
      )}
    </section>
  );
}
