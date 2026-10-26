import {validateBrowserDocument, type BrowserDocument, type BrowserSnapshot} from '../core/browser-state';
import {BrowserStorageError, type BrowserRepository} from './repository';
import type {BrowserVoiceLease} from './voice/types';

export type BrowserStorageStatus = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'unavailable';
export interface BrowserController {
  snapshot(): BrowserSnapshot;
  pendingDocument(): BrowserDocument;
  subscribe(listener: () => void): () => void;
  change(mutator: (latest: BrowserDocument) => BrowserDocument): Promise<BrowserSnapshot>;
  flush(): Promise<void>;
  replace(document: BrowserDocument): Promise<BrowserSnapshot>;
  recoveries(): Promise<BrowserSnapshot[]>;
  reloadLatest(): Promise<BrowserSnapshot>;
  withOperation<T>(kind: 'lab' | 'model', operation: () => Promise<T>): Promise<T>;
  acquireUpdateLock(): () => void;
  documentGeneration(): number;
  messageDraftRevision(key: string): number;
  acquireVoiceOperation(): BrowserVoiceLease;
  isBusy(): boolean;
  hasPending(): boolean;
  storageStatus(): BrowserStorageStatus;
  close(): void;
}
const copy = <T>(value: T): T => structuredClone(value);
const blocked = () => new BrowserStorageError('unavailable', '当前有操作正在进行，请等待完成。');
const conflict = () => new BrowserStorageError('revision-conflict', '另一个页面已更新，请先导出待存内容再明确读取最新记录。');
const asStorageError = (cause: unknown) => cause instanceof BrowserStorageError ? cause : new BrowserStorageError('unavailable', '内容尚未保存，请重试或导出待存备份。');

/** Initial read is mandatory: failure cannot create an empty replacement. */
export async function createBrowserController(repository: BrowserRepository, options: {validate?: (value: unknown) => BrowserDocument} = {}): Promise<BrowserController> {
  const validateDocument = options.validate ?? validateBrowserDocument;
  // Subscribe before the initial read: versionchange can close a connection
  // while an already active read/write transaction still completes normally.
  let invalidation: BrowserStorageError | undefined;
  let handleRevision: ((revision: number) => void) | undefined;
  const unsubscribe = repository.subscribe(revision => {
    if (revision < 0) invalidation = new BrowserStorageError('unavailable', '数据库连接已关闭或升级，请重新打开工作台。');
    handleRevision?.(revision);
  });
  let saved: BrowserSnapshot;
  try {saved = copy(await repository.load()); if (invalidation) throw invalidation;}
  catch (cause) {unsubscribe(); throw cause;}
  let pending = copy(saved.document);
  let generation = 0;
  let savedGeneration = 0;
  let documentGeneration = 0;
  const draftRevisions = new Map<string, number>();
  let queued = 0;
  let operations = 0;
  let voiceLease: BrowserVoiceLease | undefined;
  let exclusive = false;
  let updateLocked = false;
  let closed = false;
  let lastError: BrowserStorageError | undefined;
  let tail: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const emit = () => {for (const listener of listeners) {try {listener();} catch {/* Subscribers do not own storage. */}}};
  const hasPending = () => generation !== savedGeneration;
  const isBusy = () => queued > 0 || operations > 0 || exclusive || updateLocked;
  const ensureOpen = () => {if (invalidation) throw invalidation; if (closed) throw new BrowserStorageError('unavailable', '此工作台已关闭，请重新打开。');};
  const ensureAction = () => {ensureOpen(); if (exclusive || updateLocked) throw blocked();};
  const ensureExclusive = () => {ensureOpen(); if (isBusy() || hasPending()) throw blocked();};
  const storageStatus = (): BrowserStorageStatus => {
    if (invalidation) return 'unavailable';
    if (lastError?.code === 'revision-conflict') return 'conflict';
    if (lastError?.code === 'unavailable' || closed) return 'unavailable';
    if (queued > 0 || exclusive) return 'saving';
    return hasPending() ? 'unsaved' : 'saved';
  };
  const acceptPending = (document: BrowserDocument) => {
    const previous = pending.drafts.messages;
    const next = document.drafts.messages;
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (previous[key] !== next[key]) draftRevisions.set(key, (draftRevisions.get(key) ?? 0) + 1);
    }
    pending = copy(document);
  };
  handleRevision = revision => {
    if (closed || (revision >= 0 && revision <= saved.revision)) return;
    if (revision < 0) {documentGeneration++; emit(); return;}
    if (invalidation) return;
    if (hasPending() || queued || exclusive || updateLocked || operations) {lastError = conflict(); emit(); return;}
    const observedGeneration = generation;
    void repository.load().then(next => {
      if (closed || next.revision <= saved.revision) return;
      if (generation !== observedGeneration || hasPending() || isBusy()) {lastError = conflict(); emit(); return;}
      documentGeneration++; saved = copy(next); acceptPending(next.document); lastError = undefined; emit();
    }).catch(cause => {if (!closed) {lastError = asStorageError(cause); emit();}});
  };
  const flush = async () => {
    ensureOpen();
    let observed: Promise<void>;
    do {observed = tail; await observed;} while (observed !== tail);
    await repository.flush();
    ensureOpen();
    if (lastError) throw lastError;
    if (hasPending()) throw new BrowserStorageError('unavailable', '当前仍有尚未保存的内容，请重试或导出待存备份。');
  };
  const change = (mutator: (latest: BrowserDocument) => BrowserDocument): Promise<BrowserSnapshot> => {
    let candidate: BrowserDocument;
    try {
      // Storage failure cannot prevent ongoing typing from entering the
      // exportable pending document. Explicit lifecycle barriers still can.
      if (closed) throw new BrowserStorageError('unavailable', '此工作台已关闭，请重新打开。');
      if (exclusive || updateLocked) throw blocked();
      try {candidate = validateDocument(mutator(copy(pending)));} catch (cause) {throw new BrowserStorageError('invalid', cause instanceof Error ? cause.message : '学习文档格式不正确。');}
    } catch (cause) {return Promise.reject(cause);}
    acceptPending(candidate);
    const version = ++generation;
    const paused = invalidation ?? (lastError?.code === 'revision-conflict' ? lastError : undefined);
    if (paused) {emit(); return Promise.reject(paused);}
    queued++;
    const result = tail.then(async () => {
      ensureOpen();
      if (lastError?.code === 'revision-conflict') throw lastError;
      const next = await repository.commit(candidate, saved.revision);
      saved = copy(next); savedGeneration = version;
      if (generation === version) acceptPending(next.document);
      lastError = undefined;
      return copy(next);
    }).catch(cause => {lastError = asStorageError(cause); throw lastError;}).finally(() => {queued--; emit();});
    tail = result.then(() => {}, () => {});
    // Publish only after linking this write into the queue: a subscriber may
    // synchronously submit the next edit, which must follow this candidate.
    emit();
    return result;
  };
  const reloadLatest = async () => {
    ensureAction(); if (queued || operations) throw blocked();
    exclusive = true; documentGeneration++; emit();
    try {const next = await repository.load(); saved = copy(next); acceptPending(next.document); savedGeneration = ++generation; lastError = undefined; return copy(next);}
    catch (cause) {lastError = asStorageError(cause); throw lastError;}
    finally {exclusive = false; emit();}
  };
  return {
    snapshot: () => copy(saved), pendingDocument: () => copy(pending), subscribe: listener => {if (closed) return () => {}; listeners.add(listener); return () => {listeners.delete(listener);};},
    change, flush, isBusy, hasPending, storageStatus, reloadLatest,
    documentGeneration: () => documentGeneration,
    messageDraftRevision: key => draftRevisions.get(key) ?? 0,
    acquireVoiceOperation: () => {
      ensureExclusive();
      if (lastError || storageStatus() !== 'saved') throw lastError ?? blocked();
      const observedDocument = documentGeneration;
      let released = false;
      const lease: BrowserVoiceLease = {
        documentGeneration: observedDocument,
        current: () => !released && voiceLease === lease && !closed && !invalidation && !exclusive && !updateLocked
          && documentGeneration === observedDocument && lastError?.code !== 'revision-conflict' && lastError?.code !== 'unavailable',
        release: () => {
          if (released) return;
          released = true; voiceLease = undefined; operations--; emit();
        },
      };
      voiceLease = lease; operations++; emit();
      return lease;
    },
    recoveries: () => {ensureOpen(); return repository.recoveries();},
    replace: async input => {
      ensureExclusive(); if (lastError?.code === 'revision-conflict') throw lastError;
      let document: BrowserDocument;
      try {document = validateDocument(input);} catch (cause) {throw new BrowserStorageError('invalid', cause instanceof Error ? cause.message : '学习文档格式不正确。');}
      exclusive = true; documentGeneration++; emit();
      try {
        const next = await repository.replace(document, saved.revision);
        saved = copy(next); acceptPending(next.document); savedGeneration = ++generation; lastError = undefined; return copy(next);
      } catch (cause) {lastError = asStorageError(cause); throw lastError;}
      finally {exclusive = false; emit();}
    },
    withOperation: async (_kind, operation) => {ensureAction(); if (voiceLease) throw blocked(); operations++; emit(); try {return await operation();} finally {operations--; emit();}},
    acquireUpdateLock: () => {
      ensureExclusive(); if (lastError || storageStatus() !== 'saved') throw lastError ?? blocked();
      updateLocked = true; documentGeneration++; emit(); let released = false;
      return () => {if (released) return; released = true; updateLocked = false; emit();};
    },
    close: () => {if (closed) return; closed = true; documentGeneration++; unsubscribe(); listeners.clear(); repository.close();}
  };
}
