<div align="center">
  <img src="assets/icon.png" width="112" height="112" alt="Native Editor Icon" />
  <h1>Native Editor</h1>
  <p>Lightweight native macOS editor, multi-format previewer, and interactive PTY terminal built on Native Shell (<code>nsh 0.3.0</code>).</p>
</div>

## Features

- **Native Editor & Markdown / Mermaid Preview**:
  - Syntax-highlighted code editor with inline Find (`Cmd+F`) and dirty-state tracking (`Cmd+S`).
  - Markdown preview with automatic **Mermaid diagram rendering** (via local `mmd2txt` + `beautiful-mermaid` ASCII/Unicode or vector diagram fallback) and standalone `.mmd` / `.mermaid` file preview.
- **Multi-Format & Multimedia Preview**:
  - **Tables**: Native `DataTable` viewer for `.csv`, `.tsv`, and `.jsonl`.
  - **Diff**: Unified and Split Git diff viewer (`DiffView`) for `.diff` / `.patch` and modified workspace files.
  - **Multimedia**: Raster & SVG image viewer with zoom (`25%` – `400%`) and checkerboard backdrop toggle, native video player (`.mp4`, `.mov`, `.m4v`), native audio player (`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`), PDF/Document Quick Look preview, and binary Hex + ASCII dump.
- **Interactive PTY Terminal & Shell Selector**:
  - Built-in multi-tab PTY terminal (`process.spawn` + Python `pty.fork()`) with inline prompt and automatic Ghostty font/theme detection.
  - Switch between installed shells (`zsh`, `fish`, `bash`, `nu`, `sh`) directly from the terminal header dropdown or the Preferences dialog (`Cmd+,`).
- **Resizable Dock Layout**:
  - Smoothly draggable sidebar and bottom terminal panels (`ResizablePanelGroup` + `ResizablePanel`).
  - Quick Open (`Cmd+P` / `Cmd+K`) and Command Palette (`Cmd+Shift+P`).

## Development & Packaging

```sh
nsh check                           # TypeScript 7 native typecheck
nsh test --trace                    # Headless end-to-end test suite
nsh run --target macos              # Development host with hot reload
nsh package --target macos          # Build standalone macOS .app bundle
```
