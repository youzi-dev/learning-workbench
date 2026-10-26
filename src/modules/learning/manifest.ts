import type {ModuleManifest, EntitySchema} from '../../workbench/contracts/module';
import type {JsonValue} from '../../workbench/contracts/data';
/** Metadata only: importing this manifest never loads React or platform code. */
const objectSchema: EntitySchema = {version: 1, parse(value) {if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('条目内容必须是对象'); return value as JsonValue;}, migrate(value, from) {if (from !== 1) throw Error('此数据版本需要更新客户端'); return value;}};
export const manifest: ModuleManifest & {title: string} = {id: 'learning', title: '学习', version: '1.0.0', hostApiVersion: 1, schemas: {'learning.column': objectSchema, 'learning.practice': objectSchema, 'learning.lab-attempt': objectSchema, 'learning.usage': objectSchema, 'learning.lab-session': objectSchema, 'learning.lab-draft': objectSchema, 'learning.reading': objectSchema, 'learning.orphans': objectSchema}, capabilities: ['desktop-project']};
