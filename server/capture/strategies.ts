import { parse } from "node-html-parser";
import { createHash } from "node:crypto";
const candidateId = (url: string, version: string | null) =>
  createHash("sha256")
    .update(JSON.stringify([url, version]))
    .digest("hex");
import {
  publicSourceUrl,
  type CaptureCandidate,
} from "../../src/modules/library/model";
/** Candidate URLs are both metadata and transport inputs. If removing secret
 * or unreviewed parts changes the resource, omit it rather than fetch a
 * different URL. The caller can explain the protected-input requirement. */
function exactPublicCandidate(
  value: string,
  base?: string,
  onProtectedSource?: () => void,
): string | null {
  try {
    const transport = new URL(value, base).toString();
    const publicUrl = publicSourceUrl(transport);
    if (publicUrl && publicUrl !== transport) {
      onProtectedSource?.();
      return null;
    }
    return publicUrl;
  } catch {
    return null;
  }
}
export function identifyHtml(
  html: string,
  base: string,
  onProtectedSource?: () => void,
): CaptureCandidate[] {
  const root = parse(html),
    candidates: CaptureCandidate[] = [],
    seen = new Set<string>();
  function append(
    value: string | undefined,
    reason: string,
    version: string | null = null,
  ): void {
    if (!value || candidates.length >= 100) return;
    try {
      const url = exactPublicCandidate(value, base, onProtectedSource);
      if (!url || seen.has(url)) return;
      seen.add(url);
      candidates.push({
        id: candidateId(url, version),
        url,
        source: new URL(url).hostname,
        version,
        matchReason: reason,
        permission: "public",
      });
    } catch {}
  }
  for (const meta of root.querySelectorAll(
    'meta[property="og:image"],meta[name="twitter:image"]',
  ))
    append(meta.getAttribute("content"), "原页面公开图片元数据");
  for (const img of root.querySelectorAll("img")) {
    append(img.getAttribute("src"), "原页面可见图片");
    for (const entry of (img.getAttribute("srcset") ?? "").split(","))
      append(entry.trim().split(/\s+/)[0], "原页面 srcset 图片");
  }
  for (const source of root.querySelectorAll("source[srcset]"))
    for (const entry of (source.getAttribute("srcset") ?? "").split(","))
      append(entry.trim().split(/\s+/)[0], "原页面 picture/srcset 图片");
  for (const link of root.querySelectorAll(
    'link[rel="alternate"][type="application/pdf"]',
  ))
    append(
      link.getAttribute("href"),
      "原页面声明的 PDF 替代来源，需要确认版本",
      link.getAttribute("title") ?? null,
    );
  for (const video of root.querySelectorAll("video[src],video source[src]"))
    append(video.getAttribute("src"), "原页面公开视频来源");
  return candidates;
}
export function openAccessCandidates(
  metadata: unknown,
  doi: string,
  onProtectedSource?: () => void,
): CaptureCandidate[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = metadata as {
    doi?: string;
    locations?: {
      is_oa?: boolean;
      pdf_url?: string;
      landing_page_url?: string;
      version?: string;
      source?: { display_name?: string };
    }[];
  };
  if (
    value.doi?.replace(/^https:\/\/doi.org\//, "").toLowerCase() !==
    doi.toLowerCase()
  )
    return [];
  return (value.locations ?? [])
    .filter((location) => location.is_oa === true)
    .flatMap((location, index) => {
      const url = exactPublicCandidate(
        location.pdf_url ?? location.landing_page_url ?? "",
        undefined,
        onProtectedSource,
      );
      if (!url) return [];
      const version = location.version ?? "版本未标注";
      return [
        {
          id: candidateId(url, version),
          url,
          source: location.source?.display_name ?? new URL(url).hostname,
          version,
          matchReason: `DOI ${doi} 相同；来源标注 ${version}，需要确认版本`,
          permission: "public" as const,
        },
      ];
    })
    .slice(0, 100);
}
export function videoAdapter(value: string): boolean {
  const source = new URL(value),
    host = source.hostname;
  return (
    /\.(mp4|webm|ogv)$/i.test(source.pathname) ||
    /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|vimeo\.com|archive\.org)$/.test(
      host,
    )
  );
}
export async function publicVersions(
  doi: string,
  fetchJson: (url: string) => Promise<unknown>,
  onProtectedSource?: () => void,
): Promise<CaptureCandidate[]> {
  if (!/^10\.\d{4,9}\/\S{1,1000}$/.test(doi)) return [];
  try {
    return openAccessCandidates(
      await fetchJson(
        `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`,
      ),
      doi,
      onProtectedSource,
    );
  } catch {
    return [];
  }
}
