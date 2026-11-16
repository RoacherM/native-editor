import { describe, expect, open, test } from "nsh/test";
import * as termMod from "./TerminalPane";
import { linkTarget } from "./TerminalPane";

describe("TerminalPane Wave 2B unit & headless contracts", () => {
  test("linkTarget preserves App.test.tsx compatibility and supports #L anchors and OSC 8 file:// URLs", () => {
    expect(linkTarget("https://example.com/a?b=1", "/w", "/h")).toEqual({
      url: "https://example.com/a?b=1",
    });
    expect(linkTarget("src/a.ts:12:3", "/w", "/h")).toEqual({ file: "/w/src/a.ts" });
    expect(linkTarget("src/a.ts:12", "/w", "/h")).toEqual({ file: "/w/src/a.ts" });
    expect(linkTarget("src/a.ts#L12", "/w", "/h")).toEqual({ file: "/w/src/a.ts" });
    expect(linkTarget("~/notes.md:9", "/w", "/h")).toEqual({ file: "/h/notes.md" });
    expect(linkTarget("/etc/hosts", "/w", "/h")).toEqual({ file: "/etc/hosts" });
    expect(linkTarget("ftp://x", "/w", "/h")).toEqual({ file: "/w/ftp:/x" });
    expect(linkTarget("file:///Users/me/proj/src/a.ts#L5", "/w", "/h")).toEqual({
      file: "/Users/me/proj/src/a.ts",
    });
  });

  test("openTerminalLink resolves :line:col, #L, ~, and OSC 8 file:// via resolveTarget + statDisk and forwards 1-based location", async () => {
    const openTerminalLink = (
      termMod as unknown as {
        openTerminalLink?: (
          raw: string,
          opts: { baseDir: string; homeDir: string },
          deps: {
            stat: (p: string) => Promise<{ isFile: boolean; isDirectory: boolean } | null>;
            openExternal: (url: string) => void;
            onFileOpen?: (filePath: string, location?: { line: number; column: number }) => void;
          },
        ) => Promise<void>;
      }
    ).openTerminalLink;
    expect(typeof openTerminalLink).toBe("function");

    const disk = new Map<string, { isFile: boolean; isDirectory: boolean }>([
      ["/w/src/a.ts", { isFile: true, isDirectory: false }],
      ["/Users/me/foo.ts", { isFile: true, isDirectory: false }],
      ["/Users/me/proj/src/a.ts", { isFile: true, isDirectory: false }],
      ["/w/odd:2", { isFile: true, isDirectory: false }],
      ["/w/src", { isFile: false, isDirectory: true }],
    ]);
    const openedFiles: Array<{ path: string; loc?: { line: number; column: number } }> = [];
    const openedUrls: string[] = [];
    const deps = {
      stat: async (p: string) => disk.get(p) ?? null,
      openExternal: (url: string) => openedUrls.push(url),
      onFileOpen: (filePath: string, loc?: { line: number; column: number }) => {
        openedFiles.push({ path: filePath, loc });
      },
    };
    const opts = { baseDir: "/w", homeDir: "/Users/me" };

    await openTerminalLink!("src/a.ts:12:3", opts, deps);
    await openTerminalLink!("src/a.ts#L12", opts, deps);
    await openTerminalLink!("~/foo.ts:9", opts, deps);
    await openTerminalLink!("file:///Users/me/proj/src/a.ts#L5", opts, deps);
    await openTerminalLink!("file://localhost/Users/me/proj/src/a.ts#L8C4", opts, deps);
    await openTerminalLink!("odd:2", opts, deps);
    await openTerminalLink!("src", opts, deps);
    await openTerminalLink!("https://nsh.dev/docs", opts, deps);
    await openTerminalLink!("javascript:alert(1)", opts, deps);

    expect(openedFiles).toEqual([
      { path: "/w/src/a.ts", loc: { line: 12, column: 3 } },
      { path: "/w/src/a.ts", loc: { line: 12, column: 1 } },
      { path: "/Users/me/foo.ts", loc: { line: 9, column: 1 } },
      { path: "/Users/me/proj/src/a.ts", loc: { line: 5, column: 1 } },
      { path: "/Users/me/proj/src/a.ts", loc: { line: 8, column: 4 } },
      { path: "/w/odd:2", loc: undefined },
    ]);
    expect(openedUrls).toEqual(["https://nsh.dev/docs"]);
  });

  test("createSessionInputGate disables heavy-output JS wakeups once prompt settles unless mirrorOn is active", () => {
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
    const notifyCalls: boolean[] = [];
    const written: Uint8Array[] = [];
    let mirrorActive = false;

    const gate = termMod.createSessionInputGate(
      {
        write: (d) => written.push(d),
        setNotifyOutput: (on) => notifyCalls.push(on),
      },
      () => mirrorActive,
      (fn, ms) => {
        const entry = { ms, fn, cancelled: false };
        timers.push(entry);
        return entry;
      },
      (h) => {
        if (h && typeof h === "object") (h as { cancelled: boolean }).cancelled = true;
      },
    );

    const payload = new Uint8Array([108, 115, 13]);
    gate.send(payload);
    expect(written.length).toBe(0);
    expect(notifyCalls).toEqual([]);

    gate.output();
    const quietTimer = timers.find((t) => t.ms === 200)!;
    expect(quietTimer).toBeDefined();
    quietTimer.fn();

    expect(written).toEqual([payload]);
    expect(notifyCalls).toEqual([false]);

    // Calling open() again is idempotent.
    gate.open();
    expect(notifyCalls).toEqual([false]);

    // When mirrorOn is active, opening the gate keeps setNotifyOutput enabled.
    mirrorActive = true;
    const mirrorNotifyCalls: boolean[] = [];
    const mirrorGate = termMod.createSessionInputGate(
      {
        write: () => undefined,
        setNotifyOutput: (on) => mirrorNotifyCalls.push(on),
      },
      () => mirrorActive,
      () => ({}),
      () => undefined,
    );
    mirrorGate.open();
    expect(mirrorNotifyCalls).toEqual([]);

    const compiled = Object.values(termMod).map(String).join("\n");
    expect(compiled).toContain("setNotifyOutput");
    expect(compiled).not.toContain("cursor-pointer");
    expect(compiled).toContain("group-focus:bg-foreground/10");
  });

  test("probeTerminalEnvironment parallelizes pathExists/config reads via Promise.all and discoverTerminalEnvironment memoizes once per process", async () => {
    const probeEnv = (
      termMod as unknown as {
        probeTerminalEnvironment?: (io: {
          home: string;
          envShell?: string;
          readText: (p: string) => Promise<string | null>;
          pathExists: (p: string) => Promise<boolean>;
        }) => Promise<termMod.TerminalEnvironment>;
      }
    ).probeTerminalEnvironment;
    expect(typeof probeEnv).toBe("function");

    let inflight = 0;
    let maxInflight = 0;
    const checkedPaths: string[] = [];

    const env = await probeEnv!({
      home: "/Users/me",
      envShell: "/bin/zsh",
      readText: async (p) => {
        await Promise.resolve();
        if (p.endsWith("config.ghostty")) {
          return 'font-family = "JetBrains Mono"\nfont-size = 14\ncommand = /opt/homebrew/bin/fish --login\n';
        }
        return null;
      },
      pathExists: async (p) => {
        checkedPaths.push(p);
        inflight += 1;
        if (inflight > maxInflight) maxInflight = inflight;
        await new Promise((r) => setTimeout(r, 5));
        inflight -= 1;
        return (
          p === "/Applications/Ghostty.app" ||
          p === "/opt/homebrew/bin/fish" ||
          p === "/bin/zsh" ||
          p === "/bin/sh"
        );
      },
    });

    expect(maxInflight).toBeGreaterThan(2);
    // /bin/zsh from envShell and SHELL_CANDIDATES is deduplicated before statting!
    expect(checkedPaths.filter((p) => p === "/bin/zsh").length).toBe(1);
    expect(env.ghostty.fontFamily).toBe("JetBrains Mono");
    expect(env.ghostty.fontSize).toBe(14);
    expect(env.shells.map((s) => s.path)).toEqual([
      "/opt/homebrew/bin/fish",
      "/bin/zsh",
      "/bin/sh",
    ]);
    expect(env.externalApps[0]?.id).toBe("ghostty");

    // Process-wide memoization via onceAsync
    const p1 = termMod.discoverTerminalEnvironment();
    const p2 = termMod.discoverTerminalEnvironment();
    expect(p1).toBe(p2);
  });

  test("headless E2E: TabStrip keeps id:terminal-add-btn and label:Select shell reachable when tabs overflow", async () => {
    const app = await open("../App.tsx", { platform: "macos", width: 1280, height: 800 });
    await app.press("id:titlebar-toggle-terminal");
    await app.waitFor("id:terminal-pane");
    await app.setViewport(780, 600);

    expect(app.shows("label:Select shell")).toBe(true);
    expect(app.shows("label:New terminal tab")).toBe(true);

    for (let i = 0; i < 8; i += 1) {
      await app.press("id:terminal-add-btn");
    }

    expect(app.shows("id:terminal-tab-9")).toBe(true);
    expect(app.shows("id:terminal-add-btn")).toBe(true);
    expect(app.shows("id:terminal-shell-select")).toBe(true);
    await app.press("id:terminal-tab-close-9");
    expect(app.shows("id:terminal-tab-9")).toBe(false);
  });
});
