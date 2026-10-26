import type {
  ModuleManifest,
  EntitySchema,
} from "../../workbench/contracts/module";
import type { JsonValue } from "../../workbench/contracts/data";
import { parseAsset, parseCaptureJob } from "./model";
import { parseReadingState } from "./reading-state";
const schema = (parse: (value: unknown) => unknown): EntitySchema => ({
  version: 1,
  parse(value) {
    return parse(value) as JsonValue;
  },
  migrate(value, from) {
    if (from !== 1) throw Error("此资料版本需要更新客户端");
    return parse(value) as JsonValue;
  },
});
/** Metadata only: importing this manifest never loads React or platform code. */
export const manifest: ModuleManifest & { title: string } = {
  id: "library",
  title: "资料",
  version: "1.0.0",
  hostApiVersion: 1,
  schemas: {
    "library.asset": schema(parseAsset),
    "library.capture-job": schema(parseCaptureJob),
    "library.reading-state": schema(parseReadingState),
  },
  capabilities: ["files"],
};
