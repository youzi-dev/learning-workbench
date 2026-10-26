import {useLeaveProtection} from '../../workbench/ui/use-leave-protection';
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Entity } from "../../workbench/contracts/data";
import type { ModuleContext } from "../../workbench/contracts/module";
import {
  parseAsset,
  parseCaptureJob,
  type Asset,
  type CaptureJob,
  type CaptureState,
} from "./model";
import { LibraryWorkflow } from "./workflow";
import { AssetReader } from "./reader";
import type { Task } from "../tasks/model";
import type { CalendarSeries } from "../calendar/model";
import "./library.css";
const message = (cause: unknown) =>
  cause instanceof Error
    ? /disabled|not enabled|停用|未启用/i.test(cause.message)
      ? "请先在模块管理中启用待办或日程。已有资料和关联仍然保留。"
      : cause.message
    : "操作没有完成，请重试";
const labels: Record<CaptureState, string> = {
  queued: "等待获取",
  identifying: "正在识别来源",
  fetching: "正在获取文件",
  verifying: "正在校验文件",
  saved: "文件已获取并校验",
  "needs-selection": "请选择来源或版本",
  "needs-permission": "需要下载权限",
  unsupported: "暂不支持此来源",
  failed: "获取失败",
  cancelled: "已取消获取",
};
const reasons: Record<string, string> = {
  PERMISSION_REQUIRED: "来源要求登录或下载权限，可在原站取得文件后本地导入。",
  AUTH_ADAPTER_REQUIRED:
    "此来源暂不支持站点授权，可提供有权下载的链接或导入文件。",
  VIDEO_UNAVAILABLE: "此视频当前无法获取，可在原站检查可用性。",
  NETWORK_ERROR: "连接来源失败，可稍后重试。",
  UNSUPPORTED_SOURCE: "此来源暂不支持自动获取，请保留链接或导入文件。",
  TIMEOUT: "获取超时，原链接与用途已保留。",
  TOO_LARGE: "文件超过单个文件的体积上限。",
  SOURCE_INPUT_REQUIRED: "来源中的下载地址需要额外参数，请提供有权下载的完整链接，或下载后本地导入。",
  SOME_SOURCES_REQUIRE_INPUT: "以下为可直接获取的来源；其他带额外参数的来源需要提供完整下载链接，或本地导入。",
};
/** Civil Shanghai time for a quick, editable 30-minute reading slot. */
export function defaultReadingSchedule(now = new Date()) {
  const halfHour = 30 * 60 * 1000;
  const startAt = (Math.floor(now.getTime() / halfHour) + 1) * halfHour;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const civil = (at: number) => {
    const parts = formatter.formatToParts(new Date(at));
    const part = (type: string) =>
      parts.find((value) => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  };
  return {
    start: civil(startAt),
    end: civil(startAt + halfHour),
    timeZone: "Asia/Shanghai",
  };
}
function CaptureProgress({
  job,
  workflow,
  onChange,
}: {
  job: Entity<CaptureJob>;
  workflow: LibraryWorkflow;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const value = job.payload;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await onChange();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const active = ["queued", "identifying", "fetching", "verifying"].includes(
      value.state,
    ),
    index = ["queued", "identifying", "fetching", "verifying", "saved"].indexOf(
      value.state,
    );
  return (
    <section className="wb-capture-progress" aria-label="获取进度">
      <strong role="status">{labels[value.state]}</strong>
      {active && (
        <ol className="wb-progress-steps">
          {["等待", "识别", "获取", "校验", "保存"].map((name, n) => (
            <li
              key={name}
              aria-current={n === index ? "step" : undefined}
              className={n <= index ? "is-current" : ""}
            >
              {name}
            </li>
          ))}
        </ol>
      )}
      {value.errorCode && (
        <p>
          {reasons[value.errorCode] ??
            "来源未能提供可用文件，原链接与用途已保留。可以重试，或从原站取得文件后导入。"}
        </p>
      )}
      {value.state === "needs-selection" && (
        <div className="wb-candidates">
          {value.candidates.map((candidate) => (
            <article key={candidate.id}>
              <strong>{candidate.source}</strong>
              <p>
                {candidate.version ? `${candidate.version} · ` : ""}
                {candidate.matchReason}
              </p>
              <a href={candidate.url} target="_blank" rel="noopener noreferrer">
                查看此来源
              </a>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    workflow.startCapture(
                      value.assetId,
                      undefined,
                      candidate.id,
                    ),
                  )
                }
              >
                选择这个版本
              </button>
            </article>
          ))}
        </div>
      )}
      <div className="wb-actions">
        {active && (
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                workflow.context.platform.resources!.capture.cancel(job.id),
              )
            }
          >
            取消获取
          </button>
        )}
        {["failed", "cancelled", "unsupported", "needs-permission"].includes(
          value.state,
        ) && (
          <button
            disabled={busy}
            onClick={() =>
              void run(() =>
                workflow.context.platform.resources!.capture.retry(
                  job.id,
                  crypto.randomUUID(),
                ),
              )
            }
          >
            重试获取
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="wb-notice">
          {error}
        </p>
      )}
    </section>
  );
}
function AssetDetails({
  entry,
  workflow,
  context,
  job,
  onChange,
  onBlocked,
}: {
  entry: Entity<Asset>;
  workflow: LibraryWorkflow;
  context: ModuleContext;
  job?: Entity<CaptureJob>;
  onChange: () => Promise<void>;
  onBlocked?: (blocked: boolean) => void;
}) {
  const [title, setTitle] = useState(entry.payload.title),
    [purpose, setPurpose] = useState(entry.payload.purpose),
    [tags, setTags] = useState(entry.payload.tags.join("，")),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(""),
    [action, setAction] = useState<"new" | "attach" | "schedule" | null>(null),
    [tasks, setTasks] = useState<Entity<Task>[]>([]),
    [linked, setLinked] = useState<
      { id: string; title: string; enabled: boolean }[]
    >([]),
    [schedules, setSchedules] = useState<Entity<CalendarSeries>[]>([]),
    [taskId, setTaskId] = useState(""),
    [taskTitle, setTaskTitle] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [scheduleTitle, setScheduleTitle] = useState(""),
    [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [savedFields, setSavedFields] = useState(() => JSON.stringify([entry.payload.title, entry.payload.purpose, entry.payload.tags.join("，")]));
  const blocked = busy || action !== null || JSON.stringify([title, purpose, tags]) !== savedFields;
  useLeaveProtection(context.registerLeaveGuard, blocked, '请先保存资料用途或完成、取消当前事项，再离开资料。');
  useEffect(() => {onBlocked?.(blocked); return () => onBlocked?.(false);}, [blocked, onBlocked]);
  const newTask = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const all = await workflow.tasks().catch(() => []),
      refs = await context.references.backlinks({
        moduleId: "library",
        entityId: entry.id,
      });
    const links = await Promise.all(
      refs
        .filter((ref) => ref.moduleId === "tasks")
        .map(async (ref) => {
          const resolved = await context.references.resolve(ref);
          return {
            id: ref.entityId,
            title: resolved?.title ?? "已保留的待办关联",
            enabled: resolved?.moduleEnabled ?? false,
          };
        }),
    );
    return {
      all,
      links,
      schedules: await workflow
        .schedules(links.map((l) => l.id))
        .catch(() => null),
    };
  }, [workflow, context, entry.id]);
  useEffect(() => {
    let active = true,
      running = false;
    const load = () => {
      if (running) return;
      running = true;
      void refresh()
        .then((result) => {
          if (active) {
            setTasks(result.all);
            setLinked(result.links);
            if (result.schedules) setSchedules(result.schedules);
          }
        })
        .catch((cause) => {
          if (active) setError(message(cause));
        })
        .finally(() => {
          running = false;
        });
    };
    load();
    const unsub = context.subscribe(load);
    return () => {
      active = false;
      unsub();
    };
  }, [refresh, context]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await operation();
      const result = await refresh();
      setTasks(result.all);
      setLinked(result.links);
      if (result.schedules) setSchedules(result.schedules);
      await onChange();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const titleOfTask = (id: string) =>
    tasks.find((t) => t.id === id)?.payload.title ??
    linked.find((l) => l.id === id)?.title ??
    "阅读资料";
  return (
    <div className="wb-library-detail">
      <form
        aria-label="编辑资料"
        className="wb-card"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const current = await workflow.asset(entry.id);
            await workflow.saveAsset(
              {
                ...current.payload,
                title: title.trim() || current.payload.title,
                purpose,
                tags: tags
                  .split(/[，,\n]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              },
              entry.id,
            );
            setSavedFields(JSON.stringify([title, purpose, tags]));
            setSaved("用途与标签已保存在本机");
          });
        }}
      >
        <label>
          资料名称
          <input
            aria-label="资料名称"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={1000}
          />
        </label>
        <div className="wb-meta">
          <span>{entry.payload.source}</span>
          <span>
            {entry.payload.mime?.split("/")[1]?.toUpperCase() ?? "网址"}
          </span>
          {entry.payload.size !== null && (
            <span>
              {entry.payload.size < 1024 * 1024
                ? `${Math.ceil(entry.payload.size / 1024)} KB`
                : `${(entry.payload.size / 1024 / 1024).toFixed(1)} MB`}
            </span>
          )}
        </div>
        {entry.payload.publicSourceUrl && (
          <a
            href={entry.payload.publicSourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="wb-source-link"
          >
            打开原始来源
          </a>
        )}
        <label>
          准备拿它做什么？
          <textarea
            aria-label="资料用途"
            placeholder="例如：查一下项目中的缓存实现"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={3}
            maxLength={10000}
          />
        </label>
        <label>
          标签
          <input
            aria-label="资料标签"
            placeholder="用逗号分隔，如：项目，阅读"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        <div className="wb-form-footer">
          <small>写下用途后，可以继续安排下一步。</small>
          <button className="wb-primary" disabled={busy}>
            保存用途与标签
          </button>
        </div>
        {saved && (
          <p className="wb-saved" role="status">
            {saved}
          </p>
        )}
      </form>
      {job && (
        <CaptureProgress job={job} workflow={workflow} onChange={onChange} />
      )}
      <AssetReader entry={entry} workflow={workflow} />
      <section className="wb-card wb-next-action" aria-label="资料后续事项">
        <h3>接下来做什么</h3>
        <div className="wb-actions">
          <button
            onClick={() => {
              setAction("new");
              setTaskTitle(purpose || `阅读：${title}`);
            }}
            disabled={busy}
          >
            新建待办
          </button>
          <button onClick={() => setAction("attach")} disabled={busy}>
            关联已有待办
          </button>
          <button
            onClick={() => {
              if (!start || !end) {
                const defaults = defaultReadingSchedule();
                setStart(defaults.start);
                setEnd(defaults.end);
              }
              setAction("schedule");
              setTaskId(linked[0]?.id ?? "new");
              setTaskTitle(purpose || `阅读：${title}`);
              setScheduleTitle(`阅读：${title}`);
            }}
            disabled={busy}
          >
            安排时间
          </button>
        </div>
        {linked.length > 0 && (
          <ul className="wb-linked-tasks" aria-label="关联待办">
            {linked.map((link) => (
              <li key={link.id}>
                {context.references.open && link.enabled ? <button onClick={() => void context.references.open!({moduleId: 'tasks', entityId: link.id}).catch(cause => setError(message(cause)))}>{link.title}</button> : link.title}
                {!link.enabled && <small> · 待办模块已停用，关联保留</small>}
              </li>
            ))}
          </ul>
        )}
        {schedules.length > 0 && (
          <ul className="wb-linked-schedules" aria-label="关联日程">
            {schedules.map((s) => (
              <li key={s.id}>
                <strong>{s.payload.title}</strong>
                <span>
                  {s.payload.startLocal.replace("T", " ")} —{" "}
                  {s.payload.endLocal.slice(11)} · {s.payload.timeZone}
                </span>
                <small>关联待办：{titleOfTask(s.payload.taskId!)}</small>
              </li>
            ))}
          </ul>
        )}
        {action && (
          <form
            aria-label={
              action === "schedule"
                ? "安排阅读时间"
                : action === "new"
                  ? "从资料新建待办"
                  : "关联已有待办"
            }
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (action === "new") {
                  await workflow.createTodo(entry.id, taskTitle);
                  setSaved("已新建并关联待办");
                } else if (action === "attach") {
                  await workflow.linkAsset(entry.id, taskId);
                  setSaved("已关联待办");
                } else {
                  let target = taskId;
                  if (target === "new") {
                    target =
                      newTask.current ??
                      (await workflow.createTodo(entry.id, taskTitle));
                    newTask.current = target;
                  } else await workflow.linkAsset(entry.id, target);
                  await workflow.schedule(target, {
                    title: scheduleTitle,
                    startLocal: start,
                    endLocal: end,
                    timeZone,
                  });
                  setSaved("已安排阅读时间");
                  newTask.current = null;
                }
                setAction(null);
              });
            }}
          >
            {action !== "new" && (
              <label>
                选择待办
                <select
                  aria-label="选择关联待办"
                  value={taskId}
                  onChange={(e) => {
                    setTaskId(e.target.value);
                    newTask.current = null;
                  }}
                  required
                >
                  <option value="" disabled>
                    请选择待办
                  </option>
                  {action === "schedule" && (
                    <option value="new">新建待办并安排</option>
                  )}
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.payload.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(action === "new" ||
              (action === "schedule" && taskId === "new")) && (
              <label>
                待办标题
                <input
                  aria-label="后续待办标题"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  required
                />
              </label>
            )}
            {action === "attach" && !tasks.length && (
              <p>
                还没有待办，可使用“新建待办”。模块关闭时，请先在模块管理中启用。
              </p>
            )}
            {action === "schedule" && (
              <>
                <label>
                  日程标题
                  <input
                    aria-label="阅读日程标题"
                    value={scheduleTitle}
                    onChange={(e) => setScheduleTitle(e.target.value)}
                    required
                  />
                </label>
                <div className="wb-optional">
                  <label>
                    开始时间
                    <input
                      type="datetime-local"
                      aria-label="阅读开始时间"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    结束时间
                    <input
                      type="datetime-local"
                      aria-label="阅读结束时间"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      required
                    />
                  </label>
                </div>
                <label>
                  时区
                  <input
                    aria-label="阅读时区"
                    value={timeZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                    required
                  />
                </label>
              </>
            )}
            <div className="wb-actions">
              <button type="button" onClick={() => setAction(null)}>
                取消
              </button>
              <button
                className="wb-primary"
                disabled={busy || (action === "attach" && !taskId)}
              >
                {busy
                  ? "保存中…"
                  : action === "schedule"
                    ? "保存日程"
                    : action === "new"
                      ? "保存待办"
                      : "确认关联"}
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="wb-notice">
            {error}
          </p>
        )}
      </section>
      {!job &&
        entry.payload.publicSourceUrl &&
        entry.payload.availability !== "available" && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await workflow.startCapture(entry.id);
              })
            }
          >
            获取原链接中的文件
          </button>
        )}
    </div>
  );
}
export function LibraryPage({
  context,
  workflow,
  initialSelected,
}: {
  context: ModuleContext;
  workflow: LibraryWorkflow;
  initialSelected?: string;
}) {
  const [entries, setEntries] = useState<Entity[]>([]),
    [jobs, setJobs] = useState<Entity<CaptureJob>[]>([]),
    [selected, setSelected] = useState<string | null>(initialSelected ?? null),
    [query, setQuery] = useState(""),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState("");
  const [detailBlocked, setDetailBlocked] = useState(false);
  useLeaveProtection(context.registerLeaveGuard, busy || !!input.trim(), '请先收集或清空网址，等待当前操作完成后再离开。');
  const select = (id: string) => {if (detailBlocked) {setError('请先保存资料用途或完成、取消当前事项，再切换资料。'); return;} setError(''); setSelected(id);};
  const alive = useRef(true),
    loadSequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const assets = await workflow.list(query),
      all = await context.repository.list("library");
    if (
      !alive.current ||
      workflow.signal?.aborted ||
      sequence !== loadSequence.current
    )
      return;
    setEntries(assets);
    setJobs(
      all
        .filter(
          (e) =>
            e.kind === "library.capture-job" &&
            !e.deletedAt &&
            e.schemaVersion === 1,
        )
        .flatMap((e) => {
          try {
            return [{ ...e, payload: parseCaptureJob(e.payload) }];
          } catch {
            return [];
          }
        }),
    );
    setLoaded(true);
  }, [workflow, context, query]);
  useEffect(() => {
    void load().catch((cause) => {
      if (alive.current) {
        setError(message(cause));
        setLoaded(true);
      }
    });
    const unsub = context.subscribe(() => {
      void load().catch((cause) => {
        if (alive.current) setError(message(cause));
      });
    });
    return unsub;
  }, [context, load]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current) {
        setBusy(false);
        await load().catch((cause) => {
          if (alive.current) setError(message(cause));
        });
      }
    }
  };
  const current = entries.find((e) => e.id === selected);
  let parsed: Entity<Asset> | undefined;
  if (current?.schemaVersion === 1) {
    try {
      parsed = { ...current, payload: parseAsset(current.payload) };
    } catch {
      /* Unknown data stays visible, read-only. */
    }
  }
  return (
    <section className="wb-library">
      <div className="wb-page-intro">
        <span className="wb-eyebrow">把发现，接到行动上</span>
        <h1>资料</h1>
        <p>收集资料，记下用途，再安排下一步。</p>
      </div>
      <div
        className="wb-card wb-library-collect"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? "none" : "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (busy || detailBlocked) return;
          const files = Array.from(event.dataTransfer.files);
          if (files.length) {
            void run(async () => {
              const imported = await workflow.importFiles(files);
              if (imported[0] && alive.current) setSelected(imported[0].id);
            });
          } else {
            const text =
              event.dataTransfer.getData("text/uri-list") ||
              event.dataTransfer.getData("text/plain");
            if (text)
              void run(async () => {
                const asset = await workflow.collect(text);
                if (alive.current) setSelected(asset.id);
              });
          }
        }}
      >
        <form
          aria-label="收集资料"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              {
                const asset = await workflow.collect(input);
                if (alive.current) {
                  setSelected(asset.id);
                  setInput("");
                }
              }
            });
          }}
        >
          <label>
            粘贴网址或分享文字
            <textarea
              aria-label="资料网址"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="粘贴图片、视频、PDF 或网页链接"
              rows={2}
            />
          </label>
          <div className="wb-form-footer">
            <small>
              可拖入本地文件。原链接与用途保留，实际获取结果会单独显示。
            </small>
            <div className="wb-actions">
              <button
                type="button"
                disabled={busy || detailBlocked || !context.platform.resources}
                onClick={() =>
                  void run(async () => {
                    const imported = await workflow.importFiles();
                    if (imported[0] && alive.current)
                      setSelected(imported[0].id);
                  })
                }
              >
                本地导入
              </button>
              <button className="wb-primary" disabled={busy || detailBlocked || !input.trim()}>
                {busy ? "处理中…" : "收集资料"}
              </button>
            </div>
          </div>
        </form>
      </div>
      {error && (
        <p role="alert" className="wb-notice">
          {error}
        </p>
      )}
      <div className="wb-toolbar">
        <input
          type="search"
          aria-label="搜索资料"
          placeholder="搜索名称、用途或标签"
          value={query}
          onChange={(e) => {const value = e.target.value; void (context.prepareLeave?.() ?? Promise.resolve()).then(() => {setError(''); setQuery(value);}).catch(cause => setError(message(cause)));}}
        />
        <span>{entries.length} 份资料</span>
      </div>
      <div className="wb-library-layout">
        <aside className="wb-library-list" aria-label="资料收件箱">
          {entries.map((entry) => {
            const data = entry.payload as unknown as Partial<Asset>,
              job = jobs
                .filter((j) => j.payload.assetId === entry.id)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
            return (
              <article
                key={entry.id}
                className={`wb-library-item ${selected === entry.id ? "is-selected" : ""}`}
              >
                <button onClick={() => select(entry.id)}>
                  {typeof data.title === "string"
                    ? data.title
                    : "较新版本的资料"}
                </button>
                <small>
                  {job
                    ? labels[job.payload.state]
                    : data.availability === "available"
                      ? "文件已获取"
                      : data.availability === "pending"
                        ? "本机原件 · 等待上传"
                        : "仅保留链接"}
                </small>
                {typeof data.purpose === "string" && data.purpose && (
                  <p>{data.purpose}</p>
                )}
                {Array.isArray(data.tags) && (
                  <div className="wb-library-tags">
                    {data.tags
                      .filter((t) => typeof t === "string")
                      .map((tag) => (
                        <span className="wb-chip" key={tag}>
                          {tag}
                        </span>
                      ))}
                  </div>
                )}
              </article>
            );
          })}
          {!entries.length && (
            <p className="wb-empty-line">
              {!loaded
                ? "正在读取资料…"
                : query
                  ? "没有找到匹配的资料。"
                  : "收件箱是空的。先保存一份想继续使用的资料。"}
            </p>
          )}
        </aside>
        {parsed ? (
          <AssetDetails
            key={parsed.id}
            entry={parsed}
            workflow={workflow}
            context={context}
            job={
              jobs
                .filter((j) => j.payload.assetId === parsed.id)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
            }
            onChange={load}
            onBlocked={setDetailBlocked}
          />
        ) : current ? (
          <p className="wb-readonly">
            这份资料来自较新版本，当前保留只读。请更新客户端后编辑。
          </p>
        ) : (
          <div className="wb-library-placeholder">
            <span>收集 → 阅读 → 待办 → 日程</span>
            <h2>让资料有个去处</h2>
            <p>选择左侧资料，查看文件、记用途，或接着安排阅读时间。</p>
          </div>
        )}
      </div>
    </section>
  );
}
