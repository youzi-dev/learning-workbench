import React from "react";
import { manifest } from "./manifest";
import type {
  ModuleContext,
  WorkbenchModule,
} from "../../workbench/contracts/module";
import { LibraryWorkflow } from "./workflow";
import { LibraryPage } from "./page";
import { parseId, objectInput } from "../tasks/model";
import { parseAsset } from "./model";
import { parseReadingState } from "./reading-state";
import type { JsonValue } from "../../workbench/contracts/data";
export function createModule(): WorkbenchModule {
  let context: ModuleContext | undefined,
    workflow: LibraryWorkflow | undefined,
    unsubscribe: (() => void) | undefined,
    unsubscribeCaptures: (() => void) | undefined,
    captureTimer: ReturnType<typeof setInterval> | undefined;
  const ready = () => {
    if (!workflow) throw Error("资料模块尚未就绪");
    return workflow;
  };
  return {
    manifest,
    navigation: [{ id: "home", title: manifest.title }],
    commands: {
      async collect(input) {const value = objectInput(input); if (typeof value.url !== 'string') throw Error('请输入网址'); return await ready().collect(value.url) as unknown as JsonValue;},
      async ingestShare(input) { return await ready().ingestShare(input as unknown as import("../../workbench/contracts/platform").IncomingShare); },
      async list(input) {
        const v = objectInput(input);
        return (await ready().list(
          typeof v.query === "string" ? v.query : "",
        )) as unknown as JsonValue;
      },
      async save(input) {
        const v = objectInput(input);
        return (await ready().saveAsset(
          parseAsset(v.asset),
          v.id === undefined ? undefined : parseId(v.id),
        )) as unknown as JsonValue;
      },
      async linkAsset(input) {
        const v = objectInput(input);
        return await ready().linkAsset(parseId(v.assetId), parseId(v.taskId));
      },
      async saveReadingState(input) {
        return await ready().saveReadingState(parseReadingState(input));
      },
    },
    settings: [],
    async start(next, signal) {
      context = next;
      workflow = new LibraryWorkflow(next, signal);
      const own = workflow;
      {
        const maintain = () => {void own.maintainPastedCaptures().catch(() => {}); if (next.platform.environment === 'native') void own.maintainSharedCaptures().catch(() => {});};
        maintain(); unsubscribeCaptures = next.subscribe(maintain);
        captureTimer = setInterval(maintain, 60000);
        (captureTimer as unknown as {unref?():void}).unref?.();
      }
      unsubscribe = next.platform.resources?.onUploaded(async (id, file) => {
        if (!signal.aborted) await own.uploaded(id, file);
      });
      void next.platform.resources?.flushUploads().catch(() => {});
      signal.addEventListener(
        "abort",
        () => {
          unsubscribe?.();
          unsubscribe = undefined;
          unsubscribeCaptures?.(); unsubscribeCaptures = undefined;
          clearInterval(captureTimer); captureTimer = undefined;
        },
        { once: true },
      );
    },
    async stop() {
      unsubscribeCaptures?.(); unsubscribeCaptures = undefined;
      clearInterval(captureTimer); captureTimer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      context = undefined;
      workflow = undefined;
    },
    render(_routeId, entityId) {
      return context && workflow ? (
        <LibraryPage context={context} workflow={workflow} initialSelected={entityId} />
      ) : null;
    },
  };
}
