import { describe, expect, test } from "nsh/test";
import {
  badgeForPath,
  classifyFile,
  createLruCache,
  createQuickLookLoader,
  extensionOf,
  formatHexDump,
  imageMimeForPath,
  parseDelimitedRecords,
  parseJsonl,
  parseTableData,
  probeImageDimensions,
  VIEWER_SPECS,
  type FileKind,
} from "./classify";

describe("L0.2 bounded LRU cache (createLruCache)", () => {
  test("refreshes recency on get/set and fires onEvict on eviction, overwrite, delete, and clear", () => {
    const evicted: Array<[string, string]> = [];
    const cache = createLruCache<string, string>(2, (k, v) => {
      evicted.push([k, v]);
    });

    cache.set("a", "blob:a1");
    cache.set("b", "blob:b1");
    expect(cache.size).toBe(2);

    // Refresh "a" via get -> "b" is now oldest.
    expect(cache.get("a")).toBe("blob:a1");
    cache.set("c", "blob:c1");
    expect(evicted).toEqual([["b", "blob:b1"]]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);

    // Setting the exact same value refreshes recency without firing onEvict.
    evicted.length = 0;
    cache.set("a", "blob:a1");
    expect(evicted).toEqual([]);

    // Overwriting with a different value fires onEvict for the displaced value.
    cache.set("a", "blob:a2");
    expect(evicted).toEqual([["a", "blob:a1"]]);
    expect(cache.get("a")).toBe("blob:a2");

    // delete fires onEvict only when key existed.
    evicted.length = 0;
    expect(cache.delete("missing")).toBe(false);
    expect(cache.delete("c")).toBe(true);
    expect(evicted).toEqual([["c", "blob:c1"]]);
    expect(cache.size).toBe(1);

    // clear fires onEvict for all remaining entries.
    evicted.length = 0;
    cache.set("d", "blob:d1");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(evicted).toEqual([
      ["a", "blob:a2"],
      ["d", "blob:d1"],
    ]);
  });
});

describe("L0.3 VIEWER_SPECS, classification, badges & QuickLook deduplication", () => {
  test("VIEWER_SPECS defines capabilities and mode lists across all 11 FileKinds", () => {
    const allKinds: FileKind[] = [
      "code",
      "markdown",
      "mermaid",
      "html",
      "table",
      "diff",
      "image",
      "video",
      "audio",
      "quicklook",
      "binary",
    ];

    expect(Object.keys(VIEWER_SPECS).sort()).toEqual([...allKinds].sort());

    // canPrewarm is true ONLY for code and markdown.
    const prewarmKinds = allKinds.filter((k) => VIEWER_SPECS[k].canPrewarm);
    expect(prewarmKinds).toEqual(["code", "markdown"]);

    // rawModeLabel is "Markdown" for markdown and "Code" everywhere else.
    expect(VIEWER_SPECS.markdown.rawModeLabel).toBe("Markdown");
    for (const k of allKinds.filter((x) => x !== "markdown")) {
      expect(VIEWER_SPECS[k].rawModeLabel).toBe("Code");
    }

    // IO strategies.
    expect(VIEWER_SPECS.video.io).toBe("stat");
    expect(VIEWER_SPECS.audio.io).toBe("stat");
    expect(VIEWER_SPECS.quicklook.io).toBe("stat");
    expect(VIEWER_SPECS.image.io).toBe("bytes");
    expect(VIEWER_SPECS.binary.io).toBe("bytes");
    expect(VIEWER_SPECS.code.io).toBe("text");

    // Mode switch fix: code with hasDiff keeps ["source", "diff"] even when currentMode === "source".
    expect(
      VIEWER_SPECS.code.modes({
        mimeType: "text/plain",
        editable: true,
        hasDiff: false,
        currentMode: "source",
      }),
    ).toEqual(["source"]);
    expect(
      VIEWER_SPECS.code.modes({
        mimeType: "text/plain",
        editable: true,
        hasDiff: true,
        currentMode: "source",
      }),
    ).toEqual(["source", "diff"]);

    // Rich preview kinds & SVG include preview, source, and optional diff.
    for (const k of ["markdown", "mermaid", "html", "table"] as const) {
      expect(VIEWER_SPECS[k].hasRichPreview).toBe(true);
      expect(
        VIEWER_SPECS[k].modes({ mimeType: "text/plain", editable: true, hasDiff: false }),
      ).toEqual(["preview", "source"]);
      expect(
        VIEWER_SPECS[k].modes({ mimeType: "text/plain", editable: true, hasDiff: true }),
      ).toEqual(["preview", "source", "diff"]);
    }
    expect(
      VIEWER_SPECS.image.modes({ mimeType: "image/svg+xml", editable: true, hasDiff: true }),
    ).toEqual(["preview", "source", "diff"]);
    expect(
      VIEWER_SPECS.image.modes({ mimeType: "image/png", editable: false, hasDiff: true }),
    ).toEqual(["preview"]);

    // .diff / .patch files toggle between diff and source.
    expect(
      VIEWER_SPECS.diff.modes({ mimeType: "text/x-diff", editable: true, hasDiff: false }),
    ).toEqual(["diff", "source"]);

    // Opaque kinds return ["preview"] only.
    for (const k of ["video", "audio", "quicklook", "binary"] as const) {
      expect(
        VIEWER_SPECS[k].modes({ mimeType: "application/octet-stream", editable: false, hasDiff: true }),
      ).toEqual(["preview"]);
    }
  });

  test("badgeForPath uses extensionOf so extensionless ts/pdf files never get fake badges", () => {
    expect(extensionOf("ts")).toBe("");
    expect(badgeForPath("ts")).toBe("≡");
    expect(badgeForPath("pdf")).toBe("≡");
    expect(badgeForPath("/dir.ts/Makefile")).toBe("≡");
    expect(badgeForPath(".prettierrc")).toBe("≡");

    expect(badgeForPath("src/App.tsx")).toBe("TS");
    expect(badgeForPath("vendor/page.mjs")).toBe("JS");
    expect(badgeForPath("nsh.json")).toBe("{}");
    expect(badgeForPath("events.jsonl")).toBe("{}");
    expect(badgeForPath("events.ndjson")).toBe("{}");
    expect(badgeForPath("metrics.csv")).toBe("⊞");
    expect(badgeForPath("README.md")).toBe("M↓");
    expect(badgeForPath("flow.mmd")).toBe("M◇");
    expect(badgeForPath("index.html")).toBe("<>");
    expect(badgeForPath("fix.patch")).toBe("±");
    expect(badgeForPath("manual.pdf")).toBe("PDF");
    expect(badgeForPath("logo.svg")).toBe("SVG");
    expect(badgeForPath("photo.heic")).toBe("IMG");
    expect(badgeForPath("clip.mp4")).toBe("VID");
    expect(badgeForPath("song.mp3")).toBe("AUD");
  });

  test("classifies .ndjson as table and restricts quicklook (sips) strictly to .pdf", () => {
    expect(classifyFile("logs/stream.ndjson")).toEqual({
      kind: "table",
      language: "jsonl",
      defaultMode: "preview",
      mimeType: "application/x-ndjson",
    });
    expect(imageMimeForPath("/a/pic.heic")).toBe("image/heic");
    expect(imageMimeForPath("/a/notes.md")).toBeNull();

    expect(classifyFile("manual.pdf").kind).toBe("quicklook");

    const officeAndRichDocs = [
      "a.doc",
      "a.docx",
      "a.xls",
      "a.xlsx",
      "a.ppt",
      "a.pptx",
      "a.pages",
      "a.numbers",
      "a.key",
      "a.rtf",
    ];
    const asciiRtf = new TextEncoder().encode("{\\rtf1\\ansi Hello}");
    for (const file of officeAndRichDocs) {
      const c = classifyFile(file, asciiRtf);
      expect(c.kind).toBe("binary");
      expect(c.defaultMode).toBe("preview");
    }
  });

  test("QuickLook loader deduplicates inflight sips calls and bounds cache to 16 with URL revocation", async () => {
    const versions = new Map<string, string>();
    const revoked: string[] = [];
    let renderCount = 0;

    const load = createQuickLookLoader({
      maxEntries: 16,
      statVersion: async (p) => versions.get(p) ?? null,
      renderPdfUrl: async (p) => {
        renderCount += 1;
        await new Promise((r) => setTimeout(r, 5));
        return `blob:${p}#${renderCount}`;
      },
      revokeUrl: (url) => revoked.push(url),
    });

    versions.set("/a.pdf", "100:50");
    // Concurrent calls share one inflight render.
    const [u1, u2] = await Promise.all([load("/a.pdf"), load("/a.pdf")]);
    expect(u1).toBe("blob:/a.pdf#1");
    expect(u2).toBe("blob:/a.pdf#1");
    expect(renderCount).toBe(1);

    // Cached hit when stamp matches.
    expect(await load("/a.pdf")).toBe("blob:/a.pdf#1");
    expect(renderCount).toBe(1);

    // Stamp change replaces entry and revokes old blob URL.
    versions.set("/a.pdf", "200:60");
    expect(await load("/a.pdf")).toBe("blob:/a.pdf#2");
    expect(revoked).toEqual(["blob:/a.pdf#1"]);

    // Opening 16 more distinct PDFs evicts /a.pdf from the 16-entry LRU.
    revoked.length = 0;
    for (let i = 1; i <= 16; i += 1) {
      const p = `/doc-${i}.pdf`;
      versions.set(p, "1:1");
      await load(p);
    }
    expect(revoked).toEqual(["blob:/a.pdf#2"]);
  });
});

describe("fast CSV/TSV & streaming JSONL/NDJSON parsers", () => {
  test("parseDelimitedRecords scans plain runs inside quoted CSVs with escaped quotes and multiline cells", () => {
    const csv = [
      "id,title,notes,amount",
      '1,"Alpha, ""One""",plain_run_value_12345,42.5',
      '2,"Multi\r\nLine",second_plain_value,007',
      "3,,trailing,",
    ].join("\r\n");

    expect(parseDelimitedRecords(csv, ",")).toEqual([
      ["id", "title", "notes", "amount"],
      ["1", 'Alpha, "One"', "plain_run_value_12345", "42.5"],
      ["2", "Multi\nLine", "second_plain_value", "007"],
      ["3", "", "trailing", ""],
    ]);

    const table = parseTableData(csv, "items.csv");
    expect(table.rows[0]).toEqual([1, 'Alpha, "One"', "plain_run_value_12345", 42.5]);
    expect(table.rows[1]).toEqual([2, "Multi\nLine", "second_plain_value", "007"]);
  });

  test("parseJsonl streams heterogeneous schemas, supports .ndjson, and drops unterminated trailing line when partial", () => {
    const ndjson = [
      '{"a":1}',
      "bad_line",
      '{"b":"two","a":2}',
      '{"c":true}',
    ].join("\n");

    const parsed = parseTableData(ndjson, "events.ndjson");
    expect(parsed.columns.map((c) => c.title)).toEqual(["a", "b", "c"]);
    expect(parsed.rows).toEqual([
      [1, "", ""],
      [2, "two", ""],
      ["", "", "true"],
    ]);
    expect(parsed.invalidLines).toEqual([2]);

    // Partial read cut mid-JSON object: drops trailing incomplete line without invalidLines noise.
    const truncated = '{"id":1,"msg":"ok"}\n{"id":2,"msg":"cut_mid_str';
    const partialRes = parseJsonl(truncated, true);
    expect(partialRes.rows).toEqual([[1, "ok"]]);
    expect(partialRes.invalidLines).toEqual([]);

    // Non-partial read reports the broken final line in invalidLines.
    const fullRes = parseJsonl(truncated, false);
    expect(fullRes.rows).toEqual([[1, "ok"]]);
    expect(fullRes.invalidLines).toEqual([2]);

    // Partial read that happened to end cleanly on a newline keeps the last complete line.
    const newlineTerminated = '{"id":1}\n{"id":2}\n';
    expect(parseJsonl(newlineTerminated, true).rows).toEqual([[1], [2]]);
  });

  test("preserves hex dump and image dimension probes", () => {
    expect(formatHexDump(new Uint8Array(0))).toBe("(empty file)");
    expect(probeImageDimensions(new Uint8Array(0), '<svg width="80" height="40"></svg>')).toEqual({
      width: 80,
      height: 40,
    });
  });
});
