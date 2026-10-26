import {emptyBrowserDocument, validateBrowserDocument, type BrowserDocument} from '../core/browser-state';
import type {DesktopRuntime, DesktopSnapshot, DesktopWrite} from '../core/desktop-document';

export interface DesktopDocumentPort {
  load(): Promise<DesktopSnapshot>;
  save(write: DesktopWrite): Promise<DesktopSnapshot>;
  exportBackup(generation: number): Promise<boolean>;
  importBackup(generation: number): Promise<DesktopSnapshot | null>;
}
export type DesktopDocumentView = DesktopSnapshot & {
  committedDocument: BrowserDocument;
  loaded: boolean;
  status: 'loading' | 'saved' | 'saving' | 'unsaved' | 'locked';
  error: string | null;
};
export interface DesktopDocumentController {
  start(): Promise<void>;
  snapshot(): DesktopDocumentView;
  subscribe(listener: () => void): () => void;
  change(mutator: (document: BrowserDocument) => BrowserDocument, options?: {generation?: number}): Promise<void>;
  observeRuntime(data: DesktopRuntime): void;
  flush(): Promise<void>;
  exportBackup(): Promise<boolean>;
  importBackup(): Promise<boolean>;
  prepareQuit(token: string): Promise<void>;
  cancelQuit(token: string): void;
  close(): void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function checked(value: DesktopSnapshot, validate = validateBrowserDocument): DesktopSnapshot {
  for (const key of ['generation', 'revision', 'mutationRevision'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error('保存确认版本格式不正确');
  }
  return {...value, document: validate(value.document)};
}

/** Pending input is visible immediately. Only the port's actual ACK commits it. */
export function createDesktopDocumentController(port: DesktopDocumentPort, options: {validate?: (value: unknown) => BrowserDocument} = {}): DesktopDocumentController {
  const validate = options.validate ?? validateBrowserDocument;
  let document = emptyBrowserDocument();
  let committedDocument = document;
  let generation = 0, revision = 0, mutationRevision = 0, confirmedMutation = 0;
  let loaded = false, closed = false, queued = 0, error: string | null = null;
  let tail = Promise.resolve(), lastOperation = tail;
  let starting: Promise<void> | undefined;
  let runtimeBeforeLoad: DesktopRuntime | undefined;
  type Lock = {kind: 'export' | 'import'} | {kind: 'quit'; token: string; promise: Promise<void>};
  let lock: Lock | undefined;
  const listeners = new Set<() => void>();
  const status = (): DesktopDocumentView['status'] => lock ? 'locked' : !loaded ? 'loading'
    : queued ? 'saving' : confirmedMutation < mutationRevision ? 'unsaved' : 'saved';
  let view: DesktopDocumentView = freeze({document, committedDocument, generation, revision, mutationRevision, loaded, status: status(), error});
  function publish() {
    view = freeze({document, committedDocument, generation, revision, mutationRevision, loaded, status: status(), error});
    for (const listener of listeners) {try {listener();} catch { /* A view subscriber cannot interrupt a save. */ }}
  }
  function available(allowLocked = false) {
    if (closed) throw new Error('学习文档已关闭');
    if (!loaded) throw new Error('学习文档尚未加载');
    if (lock && !allowLocked) throw new Error('学习文档正在导出、恢复或退出，暂时不能修改');
  }
  function runtimeFields(target: BrowserDocument, source: BrowserDocument): BrowserDocument {
    return {...target, state: {...target.state, usageRecords: source.state.usageRecords, contexts: source.state.contexts}};
  }
  function enqueue(candidate: BrowserDocument, inputVersion: number): Promise<void> {
    const write: DesktopWrite = {document: structuredClone(candidate), generation, mutationRevision: inputVersion};
    queued += 1;
    const operation = tail.then(async () => {
      available(true);
      if (generation !== write.generation) throw new Error('学习文档已被替换');
      const ack = checked(await port.save(write), validate);
      available(true);
      if (ack.generation !== generation || ack.mutationRevision !== write.mutationRevision) throw new Error('保存确认与当前文档或输入版本不一致');
      // Runtime events can overtake an ACK. Their newer Node revision owns these
      // two fields; the ACK still confirms exactly this renderer input version.
      const accepted = ack.revision < revision ? runtimeFields(ack.document, document) : ack.document;
      committedDocument = accepted;
      confirmedMutation = inputVersion;
      if (mutationRevision === inputVersion) document = accepted;
      else document = runtimeFields(document, accepted);
      revision = Math.max(revision, ack.revision);
      error = null;
    }).catch(cause => {
      if (!closed) error = message(cause);
      throw cause;
    }).finally(() => {
      queued -= 1;
      if (!closed) publish();
    });
    // Set the queue before notifying subscribers: reentrant input must follow
    // the input whose synchronous notification triggered it.
    tail = operation.catch(() => {});
    lastOperation = operation;
    return operation;
  }
  async function flushPending(): Promise<void> {
    available(true);
    while (true) {
      if (queued) await lastOperation;
      available(true);
      if (confirmedMutation === mutationRevision) return;
      await enqueue(document, mutationRevision);
    }
  }
  function takeLock(kind: 'export' | 'import'): Lock {
    available();
    const acquired: Lock = {kind};
    lock = acquired;
    publish();
    return acquired;
  }
  function release(acquired: Lock) {
    if (lock === acquired && !closed) {lock = undefined; publish();}
  }
  const controller: DesktopDocumentController = {
    start() {
      if (closed) return Promise.reject(new Error('学习文档已关闭'));
      if (!starting) starting = (async () => {
        try {
          const initial = checked(await port.load(), validate);
          if (closed) throw new Error('学习文档已关闭');
          document = initial.document; committedDocument = document;
          generation = initial.generation; revision = initial.revision;
          mutationRevision = confirmedMutation = initial.mutationRevision;
          loaded = true; error = null;
          const waiting = runtimeBeforeLoad; runtimeBeforeLoad = undefined;
          if (waiting) controller.observeRuntime(waiting);
          publish();
        } catch (cause) {
          if (!closed) {error = message(cause); publish();}
          throw cause;
        }
      })();
      return starting;
    },
    snapshot: () => view,
    subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    change(mutator, options = {}) {
      try {
        available();
        if (options.generation !== undefined && options.generation !== generation) throw new Error('学习文档已被替换');
        if (!Number.isSafeInteger(mutationRevision + 1)) throw new Error('输入版本已超出范围');
        const candidate = validate(runtimeFields(mutator(structuredClone(document)), document));
        document = candidate; mutationRevision += 1;
        const operation = enqueue(candidate, mutationRevision);
        publish();
        return operation;
      } catch (cause) {return Promise.reject(cause);}
    },
    observeRuntime(data) {
      if (closed) return;
      if (!loaded) {
        if (!runtimeBeforeLoad || data.revision > runtimeBeforeLoad.revision) runtimeBeforeLoad = structuredClone(data);
        return;
      }
      if (data.generation !== generation || !Number.isSafeInteger(data.revision) || data.revision <= revision) return;
      const next = validate({...document, state: {...document.state, usageRecords: data.usageRecords, contexts: data.contexts}});
      document = next; committedDocument = runtimeFields(committedDocument, next);
      revision = data.revision;
      publish();
    },
    flush: flushPending,
    async exportBackup() {
      const acquired = takeLock('export');
      try {await flushPending(); available(true); const exported = await port.exportBackup(generation); available(true); return exported;}
      finally {release(acquired);}
    },
    async importBackup() {
      const acquired = takeLock('import');
      try {
        await flushPending(); available(true);
        const result = await port.importBackup(generation);
        available(true);
        if (result === null) return false;
        const restored = checked(result, validate);
        if (restored.generation !== generation + 1 || restored.mutationRevision !== 0 || restored.revision <= revision) throw new Error('恢复确认版本与当前文档不一致');
        document = committedDocument = restored.document; generation = restored.generation; revision = restored.revision;
        mutationRevision = confirmedMutation = 0; error = null;
        publish();
        return true;
      } finally {release(acquired);}
    },
    prepareQuit(token) {
      if (lock?.kind === 'quit' && lock.token === token) return lock.promise;
      try {available();} catch (cause) {return Promise.reject(cause);}
      const promise = Promise.resolve().then(flushPending);
      lock = {kind: 'quit', token, promise};
      publish();
      return promise;
    },
    cancelQuit(token) {
      if (lock?.kind === 'quit' && lock.token === token && !closed) {lock = undefined; publish();}
    },
    close() {closed = true; listeners.clear();},
  };
  return controller;
}
