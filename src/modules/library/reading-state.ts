import { parseId } from "../tasks/model";
export type ReadingState = {
  assetId: string;
  page: number;
  bookmarks: number[];
};
export function parseReadingState(input: unknown): ReadingState {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("阅读记录无效");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["assetId", "page", "bookmarks"].includes(k)) ||
    !Number.isSafeInteger(v.page) ||
    (v.page as number) < 1 ||
    !Array.isArray(v.bookmarks) ||
    v.bookmarks.length > 10000 ||
    v.bookmarks.some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw Error("阅读页码无效");
  return {
    assetId: parseId(v.assetId),
    page: v.page as number,
    bookmarks: [...new Set(v.bookmarks as number[])].sort((a, b) => a - b),
  };
}
