import {useState, type ChangeEvent} from 'react';
import {MAX_BACKUP_JSON_BYTES, type BackupService, type RestorePreview} from '../storage/backup';
import './backup.css';
type BackupPanelProps = {service: BackupService; save?: (bytes: Uint8Array, name: string) => Promise<void>};
async function download(bytes: Uint8Array, name: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BackupPanel({service, save = download}: BackupPanelProps) {
  const [includeFiles, setIncludeFiles] = useState(false);
  const [restorePreferences, setRestorePreferences] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  async function exportBackup() {
    setBusy(true); setError(''); setStatus('');
    try {await save(await service.exportBackup({includeFiles}), `workbench-${new Date().toISOString().slice(0, 10)}.json`); setStatus('备份已生成，请保留下载的文件。');}
    catch (cause) {setError(cause instanceof Error && cause.message === 'EMBEDDED_FILES_TOO_LARGE' ? '原文件合计超过 32 MiB，请取消包含原文件，导出文件清单备份，并另行保存原件。' : cause instanceof Error && cause.message === 'BACKUP_TOO_LARGE' ? '备份超过 64 MiB，请使用适合较大备份的导出方式。' : cause instanceof Error ? cause.message : '备份未完成');}
    finally {setBusy(false);}
  }
  async function chooseBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setPreview(null); setError(''); setStatus(''); setRestorePreferences(false);
    try {
      if (file.size > MAX_BACKUP_JSON_BYTES) throw new Error('备份超过 64 MiB，请在可处理此备份的设备中恢复。');
      setPreview(await service.previewRestore(new Uint8Array(await file.arrayBuffer())));
    }
    catch (cause) {setError(cause instanceof Error ? cause.message : '无法读取备份');}
    finally {setBusy(false); event.target.value = '';}
  }
  async function restoreBackup() {
    if (!preview) return;
    setBusy(true); setError(''); setStatus('');
    try {await service.restore(preview, {restoreDevicePreferences: restorePreferences}); setStatus('已导入本机，新增记录将等待同步。');}
    catch (cause) {setError(`导入尚未完成，可使用同一备份继续：${cause instanceof Error ? cause.message : '请稍后重试'}`);}
    finally {setBusy(false);}
  }
  return <section className="wb-backup" aria-label="备份与恢复">
    <div><h2>备份与恢复</h2><p>保存所有模块的记录、关联、删除标记、冲突副本和文件清单。账户凭证不进入备份。</p></div>
    <p>较大的原文件请另行保存，并使用文件清单备份。可恢复的备份文件大小上限为 64 MiB。</p>
    <div className="wb-backup-actions">
      <label><input type="checkbox" checked={includeFiles} onChange={event => setIncludeFiles(event.target.checked)} disabled={busy}/> 包含可读取的原文件（合计最多 32 MiB）</label>
      <button type="button" onClick={exportBackup} disabled={busy}>导出备份</button>
      <label className="wb-backup-import">选择备份<input type="file" accept=".json,application/json" onChange={chooseBackup} disabled={busy}/></label>
    </div>
    {preview && <div className="wb-backup-preview">
      <h3>恢复预览</h3>
      {preview.readonly ? <p role="status">此备份使用当前版本不支持的结构。已保留原文件，请更新应用后恢复。</p> : <>
        <dl><div><dt>记录</dt><dd>{preview.entities.length}</dd></div><div><dt>文件清单</dt><dd>{preview.files.length}</dd></div><div><dt>冲突副本</dt><dd>{preview.conflicts.length}</dd></div></dl>
        <p>导入会保留本机已有记录；相同编号的不同内容会留下冲突副本，供你确认。</p>
        {preview.missingFiles.length > 0 && <p>有 {preview.missingFiles.length} 个原文件未包含在备份中，恢复后需联网获取或重新导入。</p>}
        <label><input type="checkbox" checked={restorePreferences} onChange={event => setRestorePreferences(event.target.checked)} disabled={busy}/> 同时恢复允许导出的本机显示偏好</label>
        <button type="button" onClick={restoreBackup} disabled={busy}>确认导入本机</button>
      </>}
      <button type="button" onClick={() => save(preview.source, 'workbench-original-backup.json')} disabled={busy}>保存原备份</button>
    </div>}
    {busy && <p role="status">正在处理，请稍候…</p>}
    {status && <p role="status">{status}</p>}
    {error && <p className="wb-backup-error" role="alert">{error}</p>}
  </section>;
}
