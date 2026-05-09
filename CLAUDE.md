# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VibeCoding Dashboard is a single-file, zero-dependency personal project tracker with a Korean-language UI. The entire application lives in `index.html` — HTML structure, inline CSS, and vanilla JavaScript all in one file. There is no build step, no package manager, and no external dependencies.

To develop: open `index.html` directly in a browser. No server required.

## Architecture

All application logic is in the `<script>` block at the bottom of `index.html`. State is managed through three global variables:

- `projects` — array of all project objects (persisted to `localStorage` under key `vibe_v1`)
- `selected` — the currently active project object (reference into `projects`)
- `filter` — current sidebar filter string (`'전체'` means "all")

The render cycle is: **mutate state → `saveData()` → `render()` (or a specific sub-renderer)**. The top-level `render()` calls `renderStats()`, `renderFilters()`, `renderList()`, and conditionally `renderMain()`. Sub-renderers like `renderMain()` can be called directly for partial updates.

Project objects have this shape:
```js
{
  id: Number,       // Date.now() for new projects
  name: String,
  emoji: String,
  status: String,   // one of: '완료', '진행중', '계획중', '중단'
  tags: [String],
  link: String,
  files: [String],
  memo: String,
  color: String     // hex from PALETTE
}
```

## Key Conventions

**Status system:** The `STATUS` object maps Korean status strings to dot/background colors. Always use these four exact keys: `'완료'` (done), `'진행중'` (in progress), `'계획중'` (planned), `'중단'` (paused).

**CSS classes:** Reusable utility classes are defined in `<style>`: `.card`, `.btn`, `.tag`, `.proj-btn`, `.inp`, `.modal-bg`, `.modal`, `.stat-card`, `.dot`, `.status-btn`, `.file-row`. Most one-off styles are inlined directly on elements.

**Sidebar toggle:** The sidebar uses CSS class toggling (`hidden` on `#sidebar`, `full` on `#main`) driven by the `sidebarOpen` boolean. The menu button `#menu-btn` is shown/hidden inversely.

**Data bootstrap:** On load, `loadData()` reads from `localStorage`. If the key is absent or parsing fails, it falls back to `DEFAULT_PROJECTS`. This is the only place fallback defaults are injected.

**File icons:** `fileIcon(f)` maps file extensions to emojis (`.jsx`/`.tsx` → ⚛️, `.py` → 🐍, `.css` → 🎨, `.md` → 📝, everything else → 📄).
