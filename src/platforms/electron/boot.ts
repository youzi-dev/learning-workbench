import {readFile, mkdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {catalogSchemas} from '../../workbench/catalog';
import {migrateV1} from '../../workbench/storage/migration';
import {openRepository} from './repository';
import type {ModuleSettingsStore} from '../../workbench/host';
/** Source files are read verbatim before any new repository is activated. */
export async function bootElectronWorkbench(userDirectory: string) {
  let source: Uint8Array | null = null;
  for (const filename of ['document-v1.json', 'state.json']) {
    try {source = new Uint8Array(await readFile(join(userDirectory, filename))); break;} catch (cause) {if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;}
  }
  const repository = await openRepository('local-device', {directory: join(userDirectory, 'workbench-v2'), schemas: catalogSchemas});
  try {if (source) await migrateV1(source, repository); return repository;} catch (cause) {repository.close(); throw cause;}
}
/** Per-device settings with serialized atomic writes, never part of sync records. */
export function electronSettings(directory: string): ModuleSettingsStore {
  const file = join(directory, 'modules.json'); let queue = Promise.resolve();
  async function load(): Promise<Record<string, boolean>> {
    try {const value: unknown = JSON.parse(await readFile(file, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'boolean')) throw Error('模块设置格式无法读取，原文件已保留'); return value as Record<string, boolean>;} catch (cause) {if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw cause;}
  }
  return {async get(id) {await queue; const values = await load(); return Object.hasOwn(values, id) ? values[id] : null;}, async set(id, enabled) {queue = queue.catch(() => {}).then(async () => {const values = await load(); const next = {...values, [id]: enabled}; await mkdir(directory, {recursive: true}); const temp = `${file}.tmp-${randomUUID()}`; await writeFile(temp, JSON.stringify(next), {mode: 0o600}); await rename(temp, file);}); return queue;}};
}
