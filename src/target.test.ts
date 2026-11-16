import { describe, expect, test } from "nsh/test";
import {
  extensionOf,
  normalizeDirPath,
  parseTarget,
  resolveTarget,
  type FileLocation,
  type ParsedTarget,
} from "./target";

describe("L0.1 unified target & location parser (src/target.ts)", () => {
  test("routes external allowlist, anchors, and blocks dangerous or unknown URI schemes", () => {
    const cases: Array<[string, ParsedTarget]> = [
      ["https://example.com/a?b=1#top", { kind: "external", url: "https://example.com/a?b=1#top" }],
      ["http://localhost:3000/test", { kind: "external", url: "http://localhost:3000/test" }],
      ["  HTTPS://EXAMPLE.COM/X  ", { kind: "external", url: "HTTPS://EXAMPLE.COM/X" }],
      ["mailto:dev@example.com", { kind: "external", url: "mailto:dev@example.com" }],
      ["#overview", { kind: "anchor", id: "overview" }],
      ["  #根因-1  ", { kind: "anchor", id: "根因-1" }],
      ["#", { kind: "anchor", id: "" }],
      ["", { kind: "none" }],
      ["   ", { kind: "none" }],
      ["javascript:alert(1)", { kind: "none" }],
      ["JAVASCRIPT:123", { kind: "none" }],
      ["data:text/html,<script>alert(1)</script>", { kind: "none" }],
      ["vbscript:msgbox(1)", { kind: "none" }],
      ["blob:https://example.com/uuid", { kind: "none" }],
      ["about:blank", { kind: "none" }],
      ["ssh://git@github.com/org/repo", { kind: "none" }],
      ["ftp://files.example.com/a.zip", { kind: "none" }],
      ["x-apple.systempreferences:", { kind: "none" }],
      ["tel:123456", { kind: "none" }],
      ["file://otherhost/Users/me/a.ts", { kind: "none" }],
      ["file:///tmp/bad%00name.txt", { kind: "none" }],
      ["/tmp/nul\0byte.txt", { kind: "none" }],
    ];

    for (const [input, expected] of cases) {
      expect(parseTarget(input, { baseDir: "/w", homeDir: "/h" })).toEqual(expected);
    }
  });

  test("decodes file:// and file://localhost/ URLs, splitting #fragment and ?query before %XX decoding", () => {
    const cases: Array<[string, FileLocation[]]> = [
      [
        "file:///Users/me/proj/src/a.ts#L5",
        [{ path: "/Users/me/proj/src/a.ts", line: 5, column: 0 }],
      ],
      [
        "file://localhost/Users/me/My%20Notes.md#L42C7",
        [{ path: "/Users/me/My Notes.md", line: 42, column: 7 }],
      ],
      [
        "file:///tmp/c%23sharp%20guide.md?raw=1#L42-L50",
        [{ path: "/tmp/c#sharp guide.md", line: 42, column: 0 }],
      ],
      [
        "file:///tmp/foo%3A10#L20",
        [{ path: "/tmp/foo:10", line: 20, column: 0 }],
      ],
      [
        "file:///tmp/doc.md#section-heading",
        [{ path: "/tmp/doc.md", line: 0, column: 0 }],
      ],
    ];

    for (const [input, expectedItems] of cases) {
      expect(parseTarget(input)).toEqual({ kind: "candidates", items: expectedItems });
    }
  });

  test("expands ~, resolves relative paths against baseDir, and orders literal before stripped candidates", () => {
    const opts = { baseDir: "/w/docs", homeDir: "/Users/me" };

    expect(parseTarget("src/a.ts:12:3", { baseDir: "/w", homeDir: "/Users/me" })).toEqual({
      kind: "candidates",
      items: [
        { path: "/w/src/a.ts:12:3", line: 0, column: 0 },
        { path: "/w/src/a.ts:12", line: 3, column: 0 },
        { path: "/w/src/a.ts", line: 12, column: 3 },
      ],
    });

    expect(parseTarget("src/a.ts#L12", { baseDir: "/w" })).toEqual({
      kind: "candidates",
      items: [
        { path: "/w/src/a.ts#L12", line: 0, column: 0 },
        { path: "/w/src/a.ts", line: 12, column: 0 },
      ],
    });

    expect(parseTarget("../b.md#L9", opts)).toEqual({
      kind: "candidates",
      items: [
        { path: "/w/b.md#L9", line: 0, column: 0 },
        { path: "/w/b.md", line: 9, column: 0 },
      ],
    });

    expect(parseTarget("~/notes/todo.md:8", opts)).toEqual({
      kind: "candidates",
      items: [
        { path: "/Users/me/notes/todo.md:8", line: 0, column: 0 },
        { path: "/Users/me/notes/todo.md", line: 8, column: 0 },
      ],
    });

    expect(parseTarget("../docs/c%23sharp%201.md?v=1#L42C7", opts)).toEqual({
      kind: "candidates",
      items: [
        { path: "/w/docs/c%23sharp%201.md?v=1#L42C7", line: 0, column: 0 },
        { path: "/w/docs/c%23sharp%201.md", line: 42, column: 7 },
        { path: "/w/docs/c#sharp 1.md", line: 42, column: 7 },
      ],
    });

    const trailingSpace = parseTarget("/tmp/notes ");
    expect(trailingSpace).toEqual({
      kind: "candidates",
      items: [
        { path: "/tmp/notes ", line: 0, column: 0 },
        { path: "/tmp/notes", line: 0, column: 0 },
      ],
    });
  });

  test("resolveTarget prefers literal odd:2 and foo:10 (in foo:10:20) when present on disk", async () => {
    const disk = new Map<string, { isDirectory: boolean }>([
      ["/w/odd:2", { isDirectory: false }],
      ["/w/odd", { isDirectory: false }],
      ["/w/foo:10", { isDirectory: false }],
      ["/w/foo", { isDirectory: false }],
      ["/w/src/a.ts", { isDirectory: false }],
      ["/w/src", { isDirectory: true }],
    ]);
    const statted: string[] = [];
    const statFn = (p: string) => {
      statted.push(p);
      return disk.get(p) ?? null;
    };

    // Literal `odd:2` wins on the first stat without falling through to `odd`.
    const oddRes = await resolveTarget("odd:2", { baseDir: "/w" }, statFn);
    expect(oddRes).toEqual({
      kind: "file",
      path: "/w/odd:2",
      line: 0,
      column: 0,
      isDirectory: false,
    });
    expect(statted).toEqual(["/w/odd:2"]);

    // `foo:10:20` where `foo:10` exists on disk resolves to `/w/foo:10` at line 20!
    statted.length = 0;
    const fooRes = await resolveTarget("foo:10:20", { baseDir: "/w" }, statFn);
    expect(fooRes).toEqual({
      kind: "file",
      path: "/w/foo:10",
      line: 20,
      column: 0,
      isDirectory: false,
    });
    expect(statted).toEqual(["/w/foo:10:20", "/w/foo:10"]);

    // Standard `src/a.ts:12:3` resolves to `/w/src/a.ts` at line 12, col 3.
    const aRes = await resolveTarget("src/a.ts:12:3", { baseDir: "/w" }, statFn);
    expect(aRes).toEqual({
      kind: "file",
      path: "/w/src/a.ts",
      line: 12,
      column: 3,
      isDirectory: false,
    });

    // Directory target reports isDirectory: true with zeroed line/column.
    const dirRes = await resolveTarget("src", { baseDir: "/w" }, statFn);
    expect(dirRes).toEqual({
      kind: "file",
      path: "/w/src",
      line: 0,
      column: 0,
      isDirectory: true,
    });

    // External URL passes through without hitting disk; anchors & blocked schemes return null.
    expect(await resolveTarget("https://nsh.dev", { baseDir: "/w" }, statFn)).toEqual({
      kind: "external",
      url: "https://nsh.dev",
    });
    expect(await resolveTarget("#sec", { baseDir: "/w" }, statFn)).toBeNull();
    expect(await resolveTarget("javascript:void(0)", { baseDir: "/w" }, statFn)).toBeNull();
    expect(await resolveTarget("missing.ts:4", { baseDir: "/w" }, statFn)).toBeNull();
  });

  test("exports normalizeDirPath and re-exports extensionOf without fake extensionless matches", () => {
    expect(normalizeDirPath("/Users/me/proj///")).toBe("/Users/me/proj");
    expect(normalizeDirPath("/Users/me//proj/./sub/..")).toBe("/Users/me/proj");
    expect(normalizeDirPath("/")).toBe("/");
    expect(normalizeDirPath("///")).toBe("/");
    expect(normalizeDirPath("   ")).toBe("");

    expect(extensionOf("src/target.TS")).toBe("ts");
    expect(extensionOf("ts")).toBe("");
    expect(extensionOf("pdf")).toBe("");
    expect(extensionOf("/dir.v1/Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("trailing.")).toBe("");
  });
});
