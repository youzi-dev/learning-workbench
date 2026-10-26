import React, {useCallback, useEffect, useState, useRef} from 'react';
import type {Entity, EntityRef} from '../../workbench/contracts/data';
import type {ModuleContext, ReferencePort} from '../../workbench/contracts/module';
import {deviceTimeZone} from '../../workbench/activity';
import {parseJournal, type JournalEntry} from './model';
import type {JournalService} from './service';
import '../../workbench/ui/daily.css';
export function ReferenceChips({refs, references}: {refs: EntityRef[]; references: ReferencePort}) {
  const [labels, setLabels] = useState<{title: string; available: boolean}[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {let active = true; Promise.all(refs.map(async ref => {try {const result = await references.resolve(ref); return {title: result ? `${result.title}${result.deleted ? ' · 已删除' : result.moduleEnabled ? '' : ' · 模块已关闭'}` : '关联条目暂不可用', available: !!result && !result.deleted && result.moduleEnabled};} catch {return {title:'关联条目暂不可用', available:false};}})).then(value => {if (active) setLabels(value);}); return () => {active = false;};}, [refs, references]);
  return refs.length ? <div className="wb-reference-list">{refs.map((ref, index) => references.open && labels[index]?.available ? <button type="button" className="wb-chip" key={`${ref.moduleId}/${ref.entityId}`} onClick={() => {setError(''); void references.open!(ref).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));}}>{labels[index].title}</button> : <span className="wb-chip" key={`${ref.moduleId}/${ref.entityId}`}>{labels[index]?.title ?? '读取关联条目…'}</span>)}{error && <p role="alert">{error}</p>}</div> : null;
}
type ComposerContext = Pick<ModuleContext, 'invoke' | 'references' | 'registerLeaveGuard'>;
export function JournalComposer({onSave, initial, onCancel, context}: {onSave: (entry: JournalEntry) => Promise<void>; initial?: JournalEntry; onCancel?: () => void; context?: ComposerContext}) {
  const [text, setText] = useState(initial?.text ?? ''), [title, setTitle] = useState(initial?.title ?? ''), [tags, setTags] = useState(initial?.tags.join('，') ?? '');
  const [attachments, setAttachments] = useState<EntityRef[]>(initial?.attachments ?? []);
  const [materials, setMaterials] = useState<Entity[]>([]), [picker, setPicker] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dirty = useRef(false);
  dirty.current = text !== (initial?.text ?? '') || title !== (initial?.title ?? '') || tags !== (initial?.tags.join('，') ?? '') || JSON.stringify(attachments) !== JSON.stringify(initial?.attachments ?? []);
  useEffect(() => context?.registerLeaveGuard?.(async () => {if (dirty.current) throw Error('记录尚未保存，请先保存，或取消本次编辑。');}), [context]);
  useEffect(() => {
    if (!picker || !context) return;
    let active = true;
    void context.invoke('library', 'list', {}).then(value => {if (active) setMaterials((value as unknown as Entity[]).filter(e => e.kind === 'library.asset' && e.schemaVersion === 1 && !e.deletedAt));}).catch(cause => {if (active) setError(cause instanceof Error ? cause.message : '资料模块暂不可用');});
    return () => {active = false;};
  }, [context, picker]);
  const clear = () => {dirty.current = false; setText(initial?.text ?? ''); setTitle(initial?.title ?? ''); setTags(initial?.tags.join('，') ?? ''); setAttachments(initial?.attachments ?? []); setPicker(false); onCancel?.();};
  return <form aria-label={initial ? '编辑记录' : '记一下'} onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {await onSave(parseJournal({title, text, tags: tags.split(/[,，]/), attachments})); dirty.current = false; setText(''); setTitle(''); setTags(''); setAttachments([]); setPicker(false);}
    catch (cause) {setError(cause instanceof Error ? cause.message : '记录没有保存，请重试');}
    finally {setBusy(false);}
  }}>
    <label>记录内容<textarea aria-label="记录内容" placeholder="此刻想留下什么？" value={text} onChange={event => setText(event.target.value)} required/></label>
    <details><summary>标题和标签（可选）</summary><div className="wb-optional"><label>标题<input value={title} onChange={event => setTitle(event.target.value)} placeholder="不填也可以"/></label><label>标签<input value={tags} onChange={event => setTags(event.target.value)} placeholder="用逗号隔开"/></label></div></details>
    {context && <div className="wb-journal-materials"><button type="button" onClick={() => {setPicker(!picker); setError('');}}>关联已有资料</button>
      {attachments.map(ref => <div className="wb-actions" key={`${ref.moduleId}/${ref.entityId}`}><ReferenceChips refs={[ref]} references={context.references}/><button type="button" onClick={() => setAttachments(items => items.filter(item => item.moduleId !== ref.moduleId || item.entityId !== ref.entityId))}>移除关联</button></div>)}
      {picker && <fieldset><legend>选择已有资料</legend>{materials.length ? materials.map(entry => <label key={entry.id}><input type="checkbox" checked={attachments.some(ref => ref.moduleId === 'library' && ref.entityId === entry.id)} onChange={event => setAttachments(items => event.target.checked ? [...items, {moduleId: 'library', entityId: entry.id}] : items.filter(ref => ref.moduleId !== 'library' || ref.entityId !== entry.id))}/>{String((entry.payload as {title?: string}).title ?? '资料')}</label>) : <p>暂无可选资料；可先在资料模块导入。</p>}</fieldset>}
    </div>}
    {error && <p role="alert" className="wb-notice">{error}</p>}
    <div className="wb-form-footer"><small>这是你手写的日常记录</small><div className="wb-actions"><button type="button" onClick={clear}>取消</button><button className="wb-primary" disabled={busy || !text.trim()}>{busy ? '保存中…' : initial ? '保存修改' : '保存记录'}</button></div></div>
  </form>;
}
export function JournalCard({context, entry, references, onSave, onDelete, onRestore, timeZone = deviceTimeZone()}: {context?: ComposerContext; entry: Entity; timeZone?: string; references: ReferencePort; onSave?: (value: JournalEntry) => Promise<void>; onDelete?: () => Promise<void>; onRestore?: () => Promise<void>}) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  let value: JournalEntry | undefined; try {if (entry.schemaVersion === 1) value = parseJournal(entry.payload);} catch {/* Keep malformed/newer records visible without editing them. */}
  const run = async (action: () => Promise<void>) => {setBusy(true); setError(''); try {await action();} catch (cause) {setError(cause instanceof Error ? cause.message : '操作没有完成，请重试');} finally {setBusy(false);}};
  if (editing && value && onSave) return <article className="wb-card"><JournalComposer context={context} initial={value} onSave={async input => {await onSave(input); setEditing(false);}} onCancel={() => setEditing(false)}/></article>;
  const fallback = entry.payload as any;
  return <article className="wb-card"><div className="wb-meta"><span>手写记录</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('zh-CN', {timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</time>{entry.deletedAt && <span>已移入回收站</span>}</div>{(value?.title || fallback?.title) && <h3 className="wb-entry-title">{value?.title ?? String(fallback.title)}</h3>}<div className="wb-entry">{value?.text ?? (typeof fallback?.text === 'string' ? fallback.text : '此条目由较新版本保存。')}</div>{value && <><div className="wb-meta">{value.tags.map(tag => <span key={tag} className="wb-chip">{tag}</span>)}</div><ReferenceChips refs={value.attachments} references={references}/></>}{!value && <p className="wb-readonly">此记录需要更新客户端，当前只读。</p>}{value && <div className="wb-actions">{onSave && <button disabled={busy} onClick={() => setEditing(true)}>编辑</button>}{onDelete && <button disabled={busy} onClick={() => void run(onDelete)}>移入回收站</button>}{onRestore && <button disabled={busy} onClick={() => void run(onRestore)}>恢复记录</button>}</div>}{error && <p role="alert" className="wb-notice">{error}</p>}</article>;
}
export function JournalPage({context, service}: {context: ModuleContext; service: JournalService}) {
  const [entries, setEntries] = useState<Entity[]>([]), [query, setQuery] = useState(''), [trash, setTrash] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [saved, setSaved] = useState(false);
  const load = useCallback(async () => {const result = await (trash ? service.trash(query) : service.list(query)); setEntries(result); setLoaded(true); setError('');}, [service, query, trash]);
  useEffect(() => {let active = true; const refresh = () => {const pending = trash ? service.trash(query) : service.list(query); pending.then(result => {if (active) {setEntries(result); setLoaded(true); setError('');}}).catch(cause => {if (active) {setError(cause instanceof Error ? cause.message : '记录读取失败'); setLoaded(true);}});}; refresh(); const unsubscribe = context.subscribe(refresh); return () => {active = false; unsubscribe();};}, [context, service, query, trash]);
  return <section className="wb-daily"><div className="wb-page-intro"><span className="wb-eyebrow">一点一滴，留给自己</span><h1>日常记录</h1><p>标题可以不填，先把想法留下来。</p></div>{!trash && <div className="wb-card"><JournalComposer context={context} onSave={async value => {await service.saveJournal(value); setSaved(true); await load();}}/>{saved && <p role="status" className="wb-saved">已保存在本机</p>}</div>}<div className="wb-toolbar"><input type="search" aria-label="搜索记录" placeholder="搜索内容、标题或标签" value={query} onChange={event => {const value = event.target.value; void (context.prepareLeave?.() ?? Promise.resolve()).then(() => setQuery(value)).catch(cause => setError(cause.message));}}/><div className="wb-tabs"><button aria-pressed={!trash} onClick={() => void (context.prepareLeave?.() ?? Promise.resolve()).then(() => setTrash(false)).catch(cause => setError(cause.message))}>全部记录</button><button aria-pressed={trash} onClick={() => void (context.prepareLeave?.() ?? Promise.resolve()).then(() => setTrash(true)).catch(cause => setError(cause.message))}>回收站</button></div></div>{error && <p role="alert" className="wb-notice">{error}</p>}{trash && <p className="wb-trash-label">恢复后会作为一条新记录保存。</p>}{!entries.length && !error && <p className="wb-empty-line">{!loaded ? '正在读取记录…' : query ? '没有找到匹配的记录。' : trash ? '回收站是空的。' : '还没有记录，写下第一句话吧。'}</p>}{entries.map(entry => <JournalCard context={context} key={entry.id} entry={entry} references={context.references} onSave={trash ? undefined : async value => {await service.saveJournal(value, entry.id); await load();}} onDelete={trash ? undefined : async () => {await service.deleteJournal(entry.id); await load();}} onRestore={trash ? async () => {await service.restoreJournal(entry.id); await load();} : undefined}/>)}</section>;
}
