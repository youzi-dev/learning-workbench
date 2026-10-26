import {manifest as journal} from '../modules/journal/manifest';
import {manifest as tasks} from '../modules/tasks/manifest';
import {manifest as calendar} from '../modules/calendar/manifest';
import {manifest as library} from '../modules/library/manifest';
import {manifest as learning} from '../modules/learning/manifest';
/** Sole module registration seam. Pure metadata shared by native, server and clients. */
export const manifests = [journal, tasks, calendar, library, learning];
export const catalogSchemas = Object.fromEntries(manifests.map(manifest => [manifest.id, Object.fromEntries(Object.entries(manifest.schemas).map(([kind, schema]) => [kind, schema.version]))]));
