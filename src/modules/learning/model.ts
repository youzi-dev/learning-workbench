import type {LearningColumn} from '../../core/learning';
import type {SideChat} from '../../core/sidechat';
import type {ConversationContext} from '../../core/context-cache';
import type {BrowserDrafts} from '../../core/browser-state';
import type {AppState} from '../../core/state';
/** A column, its workflow and evidence always form one conflict unit. */
export type LearningColumnAggregate = {
  column: LearningColumn;
  sideChats: SideChat[];
  contexts: Record<string, ConversationContext>;
  drafts: BrowserDrafts;
  checkins: Array<AppState['checkins'][number] & {id?: string}>;
};
