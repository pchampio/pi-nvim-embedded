/**
 * Neovim-embedded editor for pi.
 *
 * Spawns `nvim --embed --clean`, forwards all keystrokes to neovim,
 * and syncs neovim's buffer/cursor state back to pi's Editor for rendering.
 *
 * - Full neovim keybindings (motions, operators, text objects, macros, …)
 * - Enter on empty last line submits the prompt
 * - ESC in normal mode passes through to pi (agent abort / double-tap cancel)
 * - Ctrl+C / Ctrl+D pass through to pi
 * - Cursor shape changes per mode (bar=insert, block=normal)
 */

import {
  CustomEditor,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { NvimClient } from "./nvim-client.js";
import { loadSettings } from "./config.js";
import type { NvimEmbeddedSettings } from "./types.js";
import { execFile } from "child_process";

// ── cursor shapes (updated from settings at load time) ───────────────

let cursorInsert = "\x1b[6 q";
let cursorNormal = "\x1b[2 q";
let currentCursorShape = cursorNormal;

// ── internals type (access pi Editor private state) ───────────────────

type EditorInternals = {
  state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
  preferredVisualCol?: number | null;
  lastAction?: string | null;
  historyIndex?: number;
  history?: string[];
  onChange?: (text: string) => void;
  tui?: { requestRender?: () => void };
};

// ── NvimEditor ────────────────────────────────────────────────────────

class NvimEditor extends CustomEditor {
  private nvim = new NvimClient();
  private ready = false;
  private fallback = false;
  private queue: string[] = [];
  private busy = false;

  // Shadow state (last-known neovim state, always current between keystrokes)
  private nLines: string[] = [""];
  private nCursorRow = 1;   // 1-indexed (neovim convention)
  private nCursorCol = 0;
  private nMode = "n";      // start in normal

  // Visual selection range (1-indexed rows, 0-indexed cols, like neovim)
  private vStartRow = 0;
  private vStartCol = 0;
  private vEndRow = 0;
  private vEndCol = 0;

  // Flush synchronization: resolves when neovim finishes processing input.
  private flushResolve: (() => void) | null = null;

  private readonly colorizers: {
    insert: (s: string) => string;
    normal: (s: string) => string;
  } | null;

  private readonly settings: NvimEmbeddedSettings;

  constructor(
    tui: any,
    theme: any,
    kb: any,
    colorizers: { insert: (s: string) => string; normal: (s: string) => string } | null,
    settings: NvimEmbeddedSettings,
  ) {
    super(tui, theme, kb);
    this.colorizers = colorizers;
    this.settings = settings;
    this.boot();
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  private async boot(): Promise<void> {
    try {
      await this.nvim.start(this.settings.nvimBinary, this.settings.nvimExtraArgs);

      // Low timeoutlen: keys arrive one at a time from our pump, no need to wait
      await this.nvim.request("nvim_set_option_value", ["timeoutlen", this.settings.timeoutlen, {}]);

      // Make it a scratch buffer so plugins (LSP, treesitter, etc.) leave it alone
      await this.nvim.request("nvim_set_option_value", ["buftype", "nofile", { buf: 0 }]);
      await this.nvim.request("nvim_set_option_value", ["bufhidden", "hide", { buf: 0 }]);
      await this.nvim.request("nvim_set_option_value", ["swapfile", false, { buf: 0 }]);
      await this.nvim.request("nvim_set_option_value", ["undofile", false, {}]);
      await this.nvim.request("nvim_set_option_value", ["backup", false, {}]);
      // Suppress all prompts ("Press ENTER", "--More--", etc.)
      await this.nvim.request("nvim_set_option_value", ["shortmess", "aAIcFWs", {}]);
      await this.nvim.request("nvim_set_option_value", ["more", false, {}]);
      await this.nvim.request("nvim_set_option_value", ["cmdheight", 1, {}]);
      // No line numbers / sign column — pi handles display chrome
      await this.nvim.request("nvim_set_option_value", ["number", false, {}]);
      await this.nvim.request("nvim_set_option_value", ["relativenumber", false, {}]);
      await this.nvim.request("nvim_set_option_value", ["signcolumn", "no", {}]);
      // Prevent filetype detection from triggering LSP/treesitter
      await this.nvim.request("nvim_set_option_value", ["filetype", "", { buf: 0 }]);
      // Disable features that block or are invisible in embedded mode
      const tmuxClipboard = this.settings.tmux.clipboard;
      const disabledKeysJson = JSON.stringify(this.settings.disabledKeys);
      await this.nvim.request("nvim_exec_lua", [`
        -- Suppress any input() calls from plugins (return empty immediately)
        vim.fn.input = function() return '' end
        vim.fn.inputlist = function() return 0 end
        vim.fn.confirm = function() return 1 end

        -- Disable LSP and treesitter for this buffer
        vim.api.nvim_create_autocmd({'BufEnter', 'BufNew'}, {
          callback = function(args)
            pcall(vim.lsp.buf_detach_client, args.buf)
            pcall(vim.treesitter.stop, args.buf)
          end
        })

        ${tmuxClipboard ? `-- Yank to register "y" → TypeScript copies to tmux
        vim.api.nvim_create_autocmd('TextYankPost', {
          callback = function()
            if vim.v.event.regname == 'y' then
              vim.g._pi_yanked = table.concat(vim.v.event.regcontents, string.char(10))
            end
          end
        })` : "-- Tmux clipboard disabled"}

        -- Suppress hit-enter prompts from plugins
        vim.opt.more = false
        vim.opt.lazyredraw = false

        -- Override keymaps AFTER user config loads (VimEnter fires after all init)
        vim.api.nvim_create_autocmd('VimEnter', {
          callback = function()
            local nop = '<Nop>'
            local modes = {'n', 'v', 'x'}

            -- Disable configured keys
            local disabled = vim.fn.json_decode('${disabledKeysJson}')
            for _, key in ipairs(disabled) do
              for _, m in ipairs(modes) do
                vim.keymap.set(m, key, nop)
              end
            end

            -- Window / tab commands (only one window in embedded mode)
            vim.keymap.set('n', '<C-w>', nop)

            -- Completion: Tab/S-Tab cycle
            vim.keymap.set('i', '<Tab>', '<C-n>', { noremap = true })
            vim.keymap.set('i', '<S-Tab>', '<C-p>', { noremap = true })

            -- Ctrl-C cancels operator-pending
            vim.keymap.set({'n', 'o'}, '<C-c>', '<Esc>', { noremap = true })

            ${tmuxClipboard ? `-- Y: yank to register y (TypeScript handles tmux clipboard)
            vim.keymap.set('n', 'Y', 'V"yy', { silent = true, noremap = true })
            vim.keymap.set({'v', 'x'}, 'Y', '"yy', { silent = true, noremap = true })` : "-- Tmux yank disabled"}
          end
        })
      `, []]);

      // Run user-provided init Lua commands
      for (const lua of this.settings.nvimInitLua) {
        await this.nvim.request("nvim_exec_lua", [lua, []]);
      }

      // Attach a UI so neovim processes typeahead and sends flush.
      // We ignore the grid data — pi's Editor handles rendering.
      await this.nvim.request("nvim_ui_attach", [80, 24, { ext_linegrid: true }]);

      // Listen for flush (end of a redraw batch = neovim done processing).
      this.nvim.onNotification("redraw", (batches) => {
        for (const batch of batches as unknown[][]) {
          if (Array.isArray(batch) && batch[0] === "flush") {
            if (this.flushResolve) {
              const resolve = this.flushResolve;
              this.flushResolve = null;
              resolve();
            }
          }
        }
      });

      // Stay in normal mode (neovim starts in normal by default).
      await this.waitForFlush(100);
      await this.sync();

      this.ready = true;
      // Drain anything queued while booting
      if (this.queue.length > 0) {
        this.pump();
      }
    } catch (err: any) {
      // If neovim failed, fall back to the base editor — pass queued input through.
      this.ready = false;
      this.fallback = true;
      for (const data of this.queue.splice(0)) {
        super.handleInput(data);
      }
    }
  }

  close(): void {
    this.nvim.close();
    // Reset cursor to blinking bar (terminal default for most shells)
    process.stdout.write("\x1b[2 q");
  }

  // ── mode helpers ───────────────────────────────────────────────────

  getMode(): "insert" | "normal" | "visual" {
    const m = this.nMode;
    if (m.startsWith("i") || m.startsWith("R")) return "insert";
    if (m === "v" || m === "V" || m === "\x16"
      || m.startsWith("s") || m.startsWith("S")) return "visual";
    return "normal";
  }

  /**
   * True only when neovim is in pure normal mode — no pending operator,
   * no replace-char wait, no Ctrl-O sub-mode, etc.
   * Only in this state should ESC / Ctrl-C bypass neovim and go to pi.
   */
  isPureNormal(): boolean {
    return this.nMode === "n";
  }

  hasPendingState(): boolean {
    // Operator-pending (no, nov, noV, no^V), replace-char (r, rm, r?),
    // Ctrl-O sub-modes (niI, niR, niV), etc. all count as pending.
    return this.getMode() === "normal" && !this.isPureNormal();
  }

  // ── input handling ─────────────────────────────────────────────────

  handleInput(data: string): void {
    // If neovim failed to start, pass everything to the base editor
    if (this.fallback) {
      super.handleInput(data);
      return;
    }

    // Bracketed paste: \x1b[200~<text>\x1b[201~
    if (data.includes("\x1b[200~")) {
      const text = data.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
      if (text) {
        this.pasteText(text);
      }
      return;
    }

    this.queue.push(data);
    if (this.ready && !this.busy) {
      this.pump();
    } else {
    }
  }

  /** Paste text into neovim at cursor position */
  private async pasteText(text: string): Promise<void> {
    if (!this.ready) return;
    try {
      const lines = text.split(/\r?\n/);
      await this.nvim.request("nvim_put", [lines, "c", false, true]);
      await this.waitForFlush(50);
      await this.sync();
    } catch (err: any) {
    }
  }

  // Keys bypassed to pi (used by pump + batch check)
  private static readonly PI_KEYS = ["ctrl+d", "alt+up", "alt+return"];

  /** Merged tmux keys from settings (paneKeys + extraKeys). */
  private get tmuxKeys(): Record<string, string[]> {
    return { ...this.settings.tmux.paneKeys, ...this.settings.tmux.extraKeys };
  }

  /** Process the input queue serially — each key waits for neovim to finish. */
  private async pump(): Promise<void> {
    this.busy = true;
    const PI_KEYS = NvimEditor.PI_KEYS;
    const TMUX_KEYS = this.tmuxKeys;
    try {
      while (this.queue.length > 0) {
        const data = this.queue.shift()!;


        // ── keys that bypass neovim ──

        // Keys that go to pi (editor shortcuts, exit, etc.)
        if (PI_KEYS.some(k => matchesKey(data, k))) {
          super.handleInput(data);
          continue;
        }

        // Tab in normal mode → toggle plan mode
        if (this.settings.tabTogglesPlanMode && (matchesKey(data, "tab") || data === "\t") && this.getMode() !== "insert") {
          const g = globalThis as any;
          if (typeof g.__piTogglePlanMode === "function") g.__piTogglePlanMode();
          continue;
        }

        // Shift+Tab: pi (thinking toggle) in normal mode, neovim (completion) in insert
        if (matchesKey(data, "shift+tab") && this.getMode() !== "insert") {
          super.handleInput(data);
          continue;
        }

        // Keys that go to tmux
        {
          let tmuxHandled = false;
          for (const [key, args] of Object.entries(TMUX_KEYS)) {
            if (matchesKey(data, key)) {
              execFile(this.settings.tmux.binary, args, () => {});
              tmuxHandled = true;
              break;
            }
          }
          if (tmuxHandled) continue;
        }

        // Ctrl+V → paste from tmux buffer
        if (this.settings.tmux.clipboard && matchesKey(data, "ctrl+v")) {
          try {
            const result = await new Promise<string>((resolve, reject) => {
              execFile(this.settings.tmux.binary, ["show-buffer"], (err, stdout) => {
                if (err) reject(err); else resolve(stdout);
              });
            });
            if (result) await this.pasteText(result);
          } catch (err: any) {
          }
          continue;
        }

        // J/K in normal mode → message history navigation
        if (this.settings.historyNavigation && (data === "K" || data === "J") && this.isPureNormal()) {
          await this.navigateHistory(data === "K" ? -1 : 1);
          continue;
        }

        // ESC in pure normal mode → pi (agent abort)
        // In operator-pending / replace-char / Ctrl-O sub-modes → neovim (cancel pending op)
        if (this.isEsc(data) && this.isPureNormal()) {
          super.handleInput(data);
          continue;
        }

        // Ctrl+C in pure normal mode → pi (abort); otherwise → neovim (cancel pending op)
        if (matchesKey(data, "ctrl+c") && this.isPureNormal()) {
          super.handleInput(data);
          continue;
        }

        // ── submission check ──
        // Normal mode: Enter submits the full buffer
        if (this.settings.enterInNormalSubmits && this.isEnter(data) && this.isPureNormal() && this.getText().trim() !== "") {
          await this.submit(false);
          continue;
        }
        // Insert mode: Enter on empty last line submits (strips trailing empty line)
        if (this.settings.enterOnEmptyLineSubmits && this.isEnter(data) && this.getMode() === "insert" && this.shouldSubmit()) {
          await this.submit(false);
          continue;
        }

        // ── forward to neovim ──
        // Batch: send this key + any remaining queued keys to neovim at once,
        // then flush + sync only once. This makes multi-key commands (diw, "0p, etc.) fast.
        try {
          let batch = this.translateKey(data);
          while (this.queue.length > 0) {
            const next = this.queue[0]!;
            // Stop batching if the next key needs special handling
            if (matchesKey(next, "ctrl+d") || this.isEsc(next) || matchesKey(next, "ctrl+c")
              || this.isEnter(next) || PI_KEYS.some(k => matchesKey(next, k))) break;
            let tmuxMatch = false;
            for (const key of Object.keys(TMUX_KEYS)) {
              if (matchesKey(next, key)) { tmuxMatch = true; break; }
            }
            if (tmuxMatch) break;
            if ((next === "K" || next === "J") && this.isPureNormal()) break;
            this.queue.shift();
            batch += this.translateKey(next);
          }
          await this.nvim.request("nvim_input", [batch]);
          await this.waitForFlush(50);
          await this.sync();
        } catch (err: any) {
          try { await this.sync(); } catch {}
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** Translate kitty protocol keys to sequences neovim understands */
  private translateKey(data: string): string {
    // Raw backspace bytes → BS (\x08) for neovim
    if (data === "\x7f" || data === "\x08") return "\x08";
    if (data === "\t") return "\t";
    if (data.length > 1) {
      if (matchesKey(data, "ctrl+w")) return "\x17";
      if (matchesKey(data, "ctrl+u")) return "\x15";
      if (matchesKey(data, "ctrl+a")) return "\x01";
      if (matchesKey(data, "ctrl+e")) return "\x05";
      if (matchesKey(data, "ctrl+r")) return "\x12";
      if (matchesKey(data, "ctrl+n")) return "\x0e";
      if (matchesKey(data, "ctrl+p")) return "\x10";
      if (matchesKey(data, "backspace")) return "\x08";
      if (matchesKey(data, "tab")) return "\x09";
      if (matchesKey(data, "shift+tab")) return "\x1b[Z";
    }
    return data;
  }

  private isEsc(data: string): boolean {
    return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
  }

  private isEnter(data: string): boolean {
    return data === "\r" || data === "\n" || matchesKey(data, "return");
  }

  /** Returns a promise that resolves on the next flush notification (or timeout). */
  private waitForFlush(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.flushResolve = resolve;
      setTimeout(() => {
        if (this.flushResolve === resolve) {
          this.flushResolve = null;
          resolve();
        }
      }, timeoutMs);
    });
  }

  /** Navigate message history. dir=-1 is older (K), dir=+1 is newer (J). */
  private async navigateHistory(dir: -1 | 1): Promise<void> {
    const e = this as unknown as EditorInternals;
    const history = e.history ?? [];
    const idx = e.historyIndex ?? -1;

    if (history.length === 0) {
      return;
    }

    // Save current text as draft when first entering history
    if (idx === -1 && dir === -1) {
      this.historyDraft = this.nLines.join("\n");
    }

    let newIdx: number;
    if (dir === -1) {
      // K → older: go from -1 to last entry, then further back
      newIdx = idx === -1 ? history.length - 1 : idx - 1;
      if (newIdx < 0) return;
    } else {
      // J → newer: go forward, past last entry returns to draft
      if (idx === -1) return;
      newIdx = idx + 1;
      if (newIdx >= history.length) newIdx = -1; // back to draft
    }

    e.historyIndex = newIdx;
    const text = newIdx === -1 ? (this.historyDraft ?? "") : history[newIdx]!;

    // Push to neovim
    const lines = text ? text.split("\n") : [""];
    try {
      await this.nvim.request("nvim_buf_set_lines", [0, 0, -1, false, lines]);
      // Move cursor to end of buffer
      await this.nvim.request("nvim_win_set_cursor", [0, [lines.length, 0]]);
      await this.waitForFlush(50);
      await this.sync();
    } catch {}

    // Clear draft when returning to it
    if (newIdx === -1) this.historyDraft = null;
  }


  /** Submit if cursor is on an empty line and buffer has real content above. */
  private shouldSubmit(): boolean {
    if (this.nLines.length <= 1 && (this.nLines[0] ?? "") === "") return false;
    const cursorLine = this.nLines[this.nCursorRow - 1] ?? "";
    return cursorLine.trim() === "";
  }

  private async submit(stripLastLine: boolean): Promise<void> {
    const text = stripLastLine
      ? this.nLines.slice(0, -1).join("\n")
      : this.nLines.join("\n").trimEnd();

    // Clear neovim buffer and go to normal mode
    try {
      await this.nvim.request("nvim_buf_set_lines", [0, 0, -1, false, [""]]);
      await this.nvim.request("nvim_input", ["\x1b"]); // ESC to ensure normal mode
      await this.waitForFlush(50);
    } catch (err: any) {
    }

    this.nLines = [""];
    this.nCursorRow = 1;
    this.nCursorCol = 0;
    this.nMode = "n";
    this.pushToEditor();

    const onSubmit = (this as any).onSubmit as ((text: string) => void) | undefined;
    if (onSubmit) onSubmit(text);
  }

  // ── neovim → pi state sync ─────────────────────────────────────────

  /** Read buffer lines, cursor, mode from neovim and update pi's Editor. */
  private async sync(): Promise<void> {
    try {
      // Use nvim_exec_lua for mode (nvim_get_mode can hang in embedded mode).
      const [lines, cursor, mode] = await Promise.all([
        this.nvim.request("nvim_buf_get_lines", [0, 0, -1, false]) as Promise<string[]>,
        this.nvim.request("nvim_win_get_cursor", [0]) as Promise<number[]>,
        this.nvim.request("nvim_exec_lua", ["return vim.fn.mode(1)", []]) as Promise<string>,
      ]);

      const prevMode = this.nMode;
      this.nLines = lines.length > 0 ? lines : [""];
      this.nCursorRow = cursor[0] ?? 1;
      this.nCursorCol = cursor[1] ?? 0;
      this.nMode = mode ?? "n";

      if (prevMode !== this.nMode) {
      }

      // Fetch visual selection bounds when in visual mode
      if (this.getMode() === "visual") {
        try {
          const sel = await this.nvim.request("nvim_exec_lua", [`
            local s = vim.fn.getpos("v")
            local e = vim.fn.getpos(".")
            return {s[2], s[3]-1, e[2], e[3]-1}
          `, []]) as number[];
          this.vStartRow = sel[0]!; this.vStartCol = sel[1]!;
          this.vEndRow = sel[2]!;   this.vEndCol = sel[3]!;
          // Normalize so start <= end
          if (this.vStartRow > this.vEndRow ||
              (this.vStartRow === this.vEndRow && this.vStartCol > this.vEndCol)) {
            [this.vStartRow, this.vStartCol, this.vEndRow, this.vEndCol] =
              [this.vEndRow, this.vEndCol, this.vStartRow, this.vStartCol];
          }
        } catch {}
      } else {
        this.vStartRow = this.vEndRow = 0;
      }

      // Escape command-line mode immediately — it's invisible in pi and will eat input.
      if (this.nMode === "c") {
        try {
          await this.nvim.request("nvim_input", ["\x03"]); // Ctrl-C
          await this.waitForFlush(50);
          // Re-sync to get the mode after escaping
          const [lines2, cursor2, mode2] = await Promise.all([
            this.nvim.request("nvim_buf_get_lines", [0, 0, -1, false]) as Promise<string[]>,
            this.nvim.request("nvim_win_get_cursor", [0]) as Promise<number[]>,
            this.nvim.request("nvim_exec_lua", ["return vim.fn.mode(1)", []]) as Promise<string>,
          ]);
          this.nLines = lines2.length > 0 ? lines2 : [""];
          this.nCursorRow = cursor2[0] ?? 1;
          this.nCursorCol = cursor2[1] ?? 0;
          this.nMode = mode2 ?? "n";
        } catch {}
      }

      // Check for yanked text and copy to tmux
      if (this.settings.tmux.clipboard) {
        try {
          const yanked = await this.nvim.request("nvim_get_var", ["_pi_yanked"]) as string;
          if (yanked) {
            execFile(this.settings.tmux.binary, ["set-buffer", "-w", yanked], () => {});
            await this.nvim.request("nvim_del_var", ["_pi_yanked"]);
          }
        } catch {} // var doesn't exist = no yank
      }

      this.pushToEditor();
    } catch (err: any) {
      // Full sync failed — try to at least keep mode in sync so
      // ESC/Ctrl-C routing stays correct and we don't get stuck.
      try {
        const mode = await this.nvim.request("nvim_exec_lua", ["return vim.fn.mode(1)", []]) as string;
        if (mode) {
          this.nMode = mode;
        }
      } catch (err2: any) {
      }
    }
  }

  /** Push shadow state into pi's Editor internals and request a re-render. */
  // Draft saved when browsing history, restored when returning to current message
  private historyDraft: string | null = null;

  private pushToEditor(): void {
    const e = this as unknown as EditorInternals;
    if (!e.state) {
      return;
    }

    e.state.lines = [...this.nLines];
    e.state.cursorLine = Math.max(0, this.nCursorRow - 1);
    e.state.cursorCol = this.nCursorCol;
    e.preferredVisualCol = null;
    e.lastAction = null;
    // Don't reset historyIndex here — navigateHistory manages it

    e.onChange?.(this.nLines.join("\n"));
    e.tui?.requestRender?.();
  }

  // ── text get/set (used by pi) ──────────────────────────────────────

  override getText(): string {
    return this.nLines.join("\n");
  }

  override setText(text: string): void {
    super.setText(text);
    if (!this.ready) return;
    const lines = text ? text.split("\n") : [""];
    this.nvim.request("nvim_buf_set_lines", [0, 0, -1, false, lines]).then(() => {
      this.nLines = lines;
      this.pushToEditor();
    }).catch(() => {});
  }

  // ── render (add mode label) ────────────────────────────────────────

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;

    // Replace ─ with - on border lines (cleaner look)
    const IS_BORDER_LINE = /^([^─]*─){6,}/;
    for (let i = 0; i < lines.length; i++) {
      if (IS_BORDER_LINE.test(lines[i]!)) {
        lines[i] = lines[i]!.replace(/─/g, "-");
      }
      // Strip pi's visual block cursor but keep the APC position marker.
      lines[i] = lines[i]!
        .replace(/(\x1b_pi:c\x07)\x1b\[7m(.)\x1b\[0m/g, "$1$2")
        .replace(/(\x1b_pi:c\x07)\x1b\[7m(.)\x1b\[27m/g, "$1$2");
    }

    // Apply visual selection highlight
    const mode = this.getMode();
    if (mode === "visual" && this.vStartRow > 0) {
      const isLinewise = this.nMode === "V" || this.nMode === "Vs";
      const isBlock = this.nMode === "\x16" || this.nMode === "\x16s";
      // Content lines are between the border lines (index 1 to lines.length-2)
      for (let bufRow = this.vStartRow; bufRow <= this.vEndRow && bufRow <= this.nLines.length; bufRow++) {
        const renderIdx = bufRow; // border top is line 0, content starts at 1
        if (renderIdx <= 0 || renderIdx >= lines.length - 1) continue;

        const lineText = this.nLines[bufRow - 1] ?? "";
        let selStart: number, selEnd: number;

        if (isLinewise) {
          selStart = 0;
          selEnd = lineText.length;
        } else if (isBlock) {
          selStart = Math.min(this.vStartCol, this.vEndCol);
          selEnd = Math.max(this.vStartCol, this.vEndCol) + 1;
        } else {
          // Charwise
          selStart = bufRow === this.vStartRow ? this.vStartCol : 0;
          selEnd = bufRow === this.vEndRow ? this.vEndCol + 1 : lineText.length;
        }

        // Apply reverse video to selected range in the rendered line
        // Strip ANSI codes to find character positions, then re-inject highlight
        const rendered = lines[renderIdx]!;
        let visPos = 0;
        let result = "";
        let inHighlight = false;
        // Walk through rendered string, tracking visible character position
        for (let j = 0; j < rendered.length; ) {
          // Skip ANSI escape sequences
          if (rendered[j] === "\x1b") {
            let end = j + 1;
            if (rendered[end] === "[") {
              while (end < rendered.length && rendered[end] !== "m") end++;
              end++; // past 'm'
            } else if (rendered[end] === "_") {
              // APC sequence: \x1b_ ... \x07
              while (end < rendered.length && rendered[end] !== "\x07") end++;
              end++; // past BEL
            } else {
              end++;
            }
            result += rendered.slice(j, end);
            j = end;
            continue;
          }
          // Visible character
          if (visPos >= selStart && visPos < selEnd && !inHighlight) {
            result += "\x1b[47m";
            inHighlight = true;
          }
          if (visPos >= selEnd && inHighlight) {
            result += "\x1b[49m";
            inHighlight = false;
          }
          result += rendered[j];
          visPos++;
          j++;
        }
        if (inHighlight) result += "\x1b[49m";
        lines[renderIdx] = result;
      }
    }

    const rawLabel = mode === "insert" ? " INSERT "
      : mode === "visual" ? " VISUAL "
      : " NORMAL ";
    const colorize = this.colorizers
      ? (mode === "insert" ? this.colorizers.insert : this.colorizers.normal)
      : null;
    const label = colorize ? colorize(rawLabel) : rawLabel;

    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= visibleWidth(rawLabel)) {
      lines[last] = truncateToWidth(lines[last]!, width - visibleWidth(rawLabel), "") + label;
    }

    // Always re-assert cursor shape — pi may reset it between renders
    const shape = mode === "insert" ? cursorInsert : cursorNormal;
    currentCursorShape = shape;
    setImmediate(() => process.stdout.write(shape));
    return lines;
  }
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let inputUnsub: (() => void) | null = null;
  let currentEditor: NvimEditor | null = null;
  let lastEscTime = 0;
  let pendingEscTimer: ReturnType<typeof setTimeout> | null = null;
  let settings: NvimEmbeddedSettings | null = null;

  function hasRunningOperations(): boolean {
    const g = globalThis as any;
    if (typeof g.__piHasRunningSubagents === "function" && g.__piHasRunningSubagents()) return true;
    if (g.__piActiveChain && typeof g.__piHasRunningChain === "function" && g.__piHasRunningChain()) return true;
    if (g.__piActivePipeline && typeof g.__piHasRunningPipeline === "function" && g.__piHasRunningPipeline()) return true;
    if (typeof g.__piHasRunningTeam === "function" && g.__piHasRunningTeam()) return true;
    return false;
  }

  function cancelAll(ctx: any) {
    const g = globalThis as any;
    let cancelled = false;
    if (!ctx.isIdle()) { ctx.abort(); cancelled = true; }
    if (typeof g.__piKillAllSubagents === "function") { const k = g.__piKillAllSubagents(); if (k > 0) cancelled = true; }
    if (typeof g.__piKillChainProc === "function") { if (g.__piKillChainProc()) cancelled = true; }
    if (typeof g.__piKillPipelineProc === "function") { if (g.__piKillPipelineProc()) cancelled = true; }
    if (typeof g.__piKillTeamProcs === "function") { const k = g.__piKillTeamProcs(); if (k > 0) cancelled = true; }
    if (cancelled) ctx.ui.notify("All operations cancelled (ESC ESC)", "warning");
  }

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("esc-hint", "\x1b[2m ESC ESC to cancel\x1b[0m");
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("esc-hint", undefined);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    lastEscTime = 0;

    if (!settings) settings = await loadSettings();
    cursorInsert = settings.cursor.insert;
    cursorNormal = settings.cursor.normal;

    const t = ctx.ui.theme;
    const colorizers = t
      ? {
          insert: (s: string) => t.fg("borderMuted", `\x1b[7m${s}\x1b[27m`),
          normal: (s: string) => t.fg("borderAccent", `\x1b[7m${s}\x1b[27m`),
        }
      : null;

    const s = settings;
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      if (currentEditor) currentEditor.close();
      const editor = new NvimEditor(tui, theme, kb, colorizers, s);
      currentEditor = editor;
      return editor;
    });

    currentCursorShape = cursorNormal;
    process.stdout.write(cursorNormal);
    process.stdout.write("\x1b[?1004h");

    if (inputUnsub) return;

    inputUnsub = ctx.ui.onTerminalInput((data: string) => {
      // Keys that pi's base editor consumes before our handleInput sees them.
      // Intercept here and forward to our editor directly.
      if (matchesKey(data, "backspace") || data === "\x7f" || data === "\x08"
        || matchesKey(data, "tab") || data === "\t"
        || matchesKey(data, "shift+tab")) {
        if (currentEditor) {
          currentEditor.handleInput(data);
          return { consume: true };
        }
      }

      if (data === "\x1b[I") {
        process.stdout.write(`\x1b[?25h${currentCursorShape}`);
        return { consume: true };
      }
      if (data === "\x1b[O") {
        process.stdout.write("\x1b[0 q\x1b[?25l"); // reset shape + hide
        return { consume: true };
      }

      // ESC double-tap cancel (only in pure normal mode while something runs)
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+[")) {
        const editor = currentEditor;
        if (!editor) return undefined;
        if (!editor.isPureNormal()) {
          return undefined;
        }

        const isIdle = ctx.isIdle();
        const hasOps = hasRunningOperations();
        const somethingRunning = !isIdle || hasOps;
        if (!somethingRunning) return undefined;

        const doubleTapWindow = settings?.doubleTapEscTimeout ?? 400;
        const now = Date.now();
        if (now - lastEscTime < doubleTapWindow) {
          lastEscTime = 0;
          if (pendingEscTimer) { clearTimeout(pendingEscTimer); pendingEscTimer = null; }
          cancelAll(ctx);
          return { consume: true };
        }

        lastEscTime = now;
        if (pendingEscTimer) clearTimeout(pendingEscTimer);
        pendingEscTimer = setTimeout(() => { lastEscTime = 0; pendingEscTimer = null; }, doubleTapWindow);
        return { consume: true };
      }

      return undefined;
    });
  });

  pi.on("session_switch", async (_event, ctx) => {
    lastEscTime = 0;
    if (ctx.hasUI) ctx.ui.setStatus("esc-hint", undefined);
  });

  pi.on("session_shutdown", async () => {
    if (inputUnsub) { inputUnsub(); inputUnsub = null; }
    if (currentEditor) { currentEditor.close(); currentEditor = null; }
    lastEscTime = 0;
    process.stdout.write("\x1b[?1004l\x1b[?25h\x1b[2 q");
  });
}
