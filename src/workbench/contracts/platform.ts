import type {EntityRef, Id, IsoTime} from './data';
import type {FilePort, LocalFileRef} from './files';
import type {ResourcePort} from './resources';
export type Capability = 'files' | 'share-receive' | 'notifications' | 'desktop-project';
export type IncomingShare = {deliveryId: Id; text?: string; url?: string; files: LocalFileRef[]; receivedAt?: IsoTime; status?: 'ready' | 'copying' | 'needs-reshare'; message?: string; dismissed?: boolean; accountId?: Id};
export type Reminder = {id: string; entity: EntityRef; occurrenceKey: string; fireAt: IsoTime; title: string};
export interface CredentialPort {get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void>;}
export interface NotificationPort {permission(): Promise<'granted' | 'denied' | 'prompt'>; reconcile(accountId: Id, reminders: Reminder[]): Promise<void>;}
export interface SharePort {pending(): Promise<IncomingShare[]>; acknowledge(deliveryId: Id): Promise<void>;}
export interface PlatformPorts {environment?: 'native'; capabilities: ReadonlySet<Capability>; files: FilePort; credentials: CredentialPort; notifications: NotificationPort; shares: SharePort; resources?: ResourcePort;}
