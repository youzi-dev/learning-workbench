import type {BrowserDocument} from '../../core/browser-state';
import {splitV1} from '../../modules/learning/migrate-v1';
import {RepositoryError, canonical, sourceFingerprint, type MigrationRepository} from './repository';
/** Snapshot bytes are copied before the first await; the caller's source is immutable. */
export async function migrateV1(source: Uint8Array, target: MigrationRepository): Promise<{fingerprint: string; imported: number}> {
  const snapshot = new Uint8Array(source);
  let raw: Record<string, unknown>;
  try {raw = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(snapshot)); canonical(raw);} catch {throw new RepositoryError('invalid', 'Invalid legacy JSON');}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RepositoryError('invalid');
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > 1) throw new RepositoryError('future-schema', 'Future source format is read-only; preserve the original and upgrade', true);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new RepositoryError('invalid', 'Unknown legacy schema');
  let document: BrowserDocument;
  if (raw.format !== undefined) {
    if (raw.format !== 'growth-workbench' || raw.schemaVersion !== 1 || !raw.browser || typeof raw.browser !== 'object') throw new RepositoryError('invalid');
    if (typeof raw.appVersion !== 'string' || !raw.appVersion.trim() || typeof raw.exportedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw.exportedAt) || !Number.isFinite(Date.parse(raw.exportedAt))) throw new RepositoryError('invalid', 'Invalid backup metadata');
    document = {state: raw.state, drafts: (raw.browser as {drafts: unknown}).drafts} as BrowserDocument;
  } else if (raw.document !== undefined) document = raw.document as BrowserDocument; // BrowserSnapshot envelope
  else if (raw.state !== undefined) document = raw as unknown as BrowserDocument;
  else document = {state: raw, drafts: {lab: {}, messages: {}, references: {}}} as unknown as BrowserDocument;
  const fingerprint = await sourceFingerprint(snapshot);
  const {entities, devicePreferences} = splitV1(document, fingerprint);
  const knownEnvelope = raw.format !== undefined ? ['format', 'schemaVersion', 'appVersion', 'exportedAt', 'state', 'browser'] : raw.document !== undefined ? ['schemaVersion', 'revision', 'updatedAt', 'document'] : raw.state !== undefined ? ['state', 'drafts'] : Object.keys(raw);
  const warnings = Object.keys(raw).filter(k => !knownEnvelope.includes(k)).map(k => `source.${k}`);
  if (raw.browser && typeof raw.browser === 'object') warnings.push(...Object.keys(raw.browser).filter(k => k !== 'drafts').map(k => `source.browser.${k}`));
  if (devicePreferences && typeof devicePreferences === 'object' && !Array.isArray(devicePreferences)) devicePreferences.migrationWarnings = [...devicePreferences.migrationWarnings as string[], ...warnings];
  return target.importV1({fingerprint, entities, devicePreferences, sourceSnapshot: snapshot});
}
