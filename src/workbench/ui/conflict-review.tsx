import {useEffect, useRef, useState} from 'react';
import type {Conflict, Entity, Id} from '../contracts/data';
import {canonical, type SyncRepository} from '../storage/repository';
import {conflictLocalVersion, conflictRemoteVersion, resolveConflict, type ConflictChoice} from '../sync/conflicts';
import './sync.css';
type ReviewItem = {conflict: Conflict; local: Entity[]; remote: Entity[]; target: Id; resolving: boolean};
export function ConflictReview({repository, deviceId, onResolved, subscribe}: {repository: SyncRepository; deviceId: Id; onResolved?(): void; subscribe?(listener: () => void): () => void}) {
  const [items, setItems] = useState<ReviewItem[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  async function load() {
    const current = ++generation.current;
    const [conflicts, queue] = await Promise.all([repository.conflicts(), repository.queue()]);
    const data = await Promise.all(conflicts.map(async conflict => ({conflict, target: await repository.resolutionTarget(conflict.id), local: await conflictLocalVersion(repository, conflict), remote: await conflictRemoteVersion(repository, conflict), resolving: queue.some(entry => entry.resolves.includes(conflict.id))})));
    if (generation.current === current) setItems(data);
  }
  useEffect(() => {
    void load().catch(() => setError('暂时无法读取冲突副本'));
    const unsubscribe = subscribe?.(() => {void load().catch(() => {});});
    return () => {generation.current++; unsubscribe?.();};
  }, [repository, subscribe]);
  async function choose(item: ReviewItem, choice: ConflictChoice) {
    setBusy(item.conflict.id); setError('');
    try {await resolveConflict(repository, item.conflict.id, choice, deviceId, item.remote); await load(); onResolved?.();}
    catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
      setError(code === 'superseded-conflict' ? '此原始冲突已有后续版本，请前往当前冲突处理。原始证据已保留。' : code === 'remote-review-changed' || code === 'stale' ? '云端又有新修改，已刷新显示。请核对当前版本后再次选择。' : code === 'missing-copy-payload' ? '此旧删除版本缺少完整内容，无法建立有效副本。原冲突仍保留。' : '此版本暂不能应用。数据已保留，请等待同步结束，或先导出并处理关联操作。');
      await load().catch(() => {});
    } finally {setBusy(null);}
  }
  return <section className="wb-conflicts" aria-label="版本冲突">
    <h2>核对两个版本</h2>
    <p>请核对每份版本的来源。导入版本与目标原有修改分别保留；另存副本会创建新记录。需要上传的选择得到确认后，原冲突才会移除。</p>
    {error && <p role="alert">{error}</p>}
    {items.length === 0 && <p>暂无需要处理的版本冲突。</p>}
    {items.map(item => {
      const {conflict, local, remote, resolving, target} = item;
      const imported = conflict.provenance?.kind === 'import';
      const deleted = remote.some(entity => entity.deletedAt);
      const missingCopy = local.some(entity => entity.deletedAt && entity.payload === null);
      const remoteChanged = canonical(remote) !== canonical(conflict.remote);
      return <article key={conflict.id} id={`wb-conflict-${conflict.id}`}>
        <h3>{deleted ? '云端已删除原记录' : '同一记录有不同修改'}</h3>
        <div className="wb-conflict-versions"><div><h4>{imported ? '本次导入版本' : '本机版本'}</h4>{local.map(entity => <Version key={`${entity.moduleId}:${entity.id}`} entity={entity}/>)}</div><div><h4>{imported ? '当前目标版本' : '当前云端版本'}</h4>{remote.length ? remote.map(entity => <Version key={`${entity.moduleId}:${entity.id}`} entity={entity}/>) : <p>{imported ? '当前目标尚无此记录；保留的已有版本见历史副本。' : '云端尚无此记录。'}</p>}</div></div>
        {remoteChanged && <details><summary>查看保留的历史云端版本</summary>{conflict.remote.map(entity => <Version key={`${entity.moduleId}:${entity.id}`} entity={entity}/>)}</details>}
        {missingCopy && <p>此旧删除版本缺少完整本机内容，无法建立有效副本。原冲突仍保留。</p>}
        {target !== conflict.id ? <p>此原始冲突仅作为证据保留。<a href={`#wb-conflict-${target}`}>前往当前冲突</a>核对并处理。</p> : resolving ? <p role="status">所选版本已存本机，等待上传确认。两个原始版本仍保留。</p> : <div className="wb-sync-actions"><button disabled={busy === conflict.id || (!imported && deleted)} onClick={() => {void choose(item, 'local');}}>{imported ? '使用导入版本' : '使用本机版本'}</button><button disabled={busy === conflict.id} onClick={() => {void choose(item, 'remote');}}>{imported ? '保留已有版本' : '使用云端版本'}</button><button disabled={busy === conflict.id || missingCopy} onClick={() => {void choose(item, 'copy');}}>{imported ? '导入版本另存副本' : '保留本机为新副本'}</button></div>}
      </article>;
    })}
  </section>;
}
function Version({entity}: {entity: Entity}) {return <div><small>{entity.moduleId} · {entity.kind} · 版本 {entity.revision}{entity.deletedAt ? ' · 已删除' : ''}</small><pre>{JSON.stringify(entity.payload, null, 2)}</pre></div>;}
