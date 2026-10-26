import type {ReactNode} from 'react';
import type {EntityRef, Id, JsonValue, ModuleId} from './data';
import type {Capability, PlatformPorts} from './platform';
import type {LocalRepository} from '../storage/repository';
export type EntitySchema = {version: number; parse(value: unknown): JsonValue; migrate(value: JsonValue, from: number): JsonValue};
export type ModuleManifest = {id: ModuleId; version: string; hostApiVersion: 1; schemas: Record<string, EntitySchema>; capabilities: Capability[]};
export interface ReferencePort {open?(ref: EntityRef): Promise<void>; resolve(ref: EntityRef): Promise<{title: string; deleted: boolean; moduleEnabled: boolean} | null>; backlinks(ref: EntityRef): Promise<EntityRef[]>;}
export type ModuleContext = {readonly deviceId: Id | null; repository: LocalRepository; references: ReferencePort; platform: PlatformPorts; learningPreferences?: {read(): Promise<JsonValue | null>}; openAccount?(): void; prepareLeave?(): Promise<void>; registerLeaveGuard?(guard: () => Promise<void>): () => void; subscribe(listener: () => void): () => void; invoke(moduleId: ModuleId, command: string, input: JsonValue): Promise<JsonValue>};
export type WorkbenchModule = {manifest: ModuleManifest; navigation: {id: string; title: string}[]; commands: Record<string, (input: JsonValue) => Promise<JsonValue>>; settings: string[]; start(context: ModuleContext, signal: AbortSignal): Promise<void>; stop(): Promise<void>; render(routeId: string, entityId?: string): ReactNode};
export type ModuleRegistration = {manifest: ModuleManifest; load(): Promise<WorkbenchModule>};
