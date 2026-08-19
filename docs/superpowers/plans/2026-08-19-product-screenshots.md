# Product Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compress three real Bitlab screenshots and present them on both localized website home pages and in the repository README.

**Architecture:** Keep one set of WebP assets in Astro's public directory so the website and GitHub README can reference the same tracked files. Add static localized screenshot markup to each home page and shared responsive presentation rules to the existing global stylesheet.

**Tech Stack:** Astro, CSS, Markdown/HTML, WebP compression via the baoyu image compressor.

## Global Constraints

- Preserve each screenshot's original 3152 × 2152 dimensions, aspect ratio, and full desktop wallpaper.
- Store one shared copy under `apps/website/public/assets/screenshots/`.
- Reuse the website's existing design tokens and responsive breakpoint.
- Do not replace the existing illustrated hero preview.

---

### Task 1: Create optimized screenshot assets

**Files:**
- Create: `apps/website/public/assets/screenshots/agent-artifact-preview.webp`
- Create: `apps/website/public/assets/screenshots/mcp-connectors.webp`
- Create: `apps/website/public/assets/screenshots/skills-library.webp`

**Interfaces:**
- Consumes: `~/Desktop/example1.png`, `~/Desktop/example2.png`, `~/Desktop/example3.png`
- Produces: Three stable `/assets/screenshots/*.webp` website URLs and repository-relative README paths.

- [ ] **Step 1: Create the destination and compress at quality 80**

```bash
mkdir -p apps/website/public/assets/screenshots
npx -y bun /Users/limbo/.config/agents/skills/baoyu-compress-image/scripts/main.ts "$HOME/Desktop/example1.png" -o apps/website/public/assets/screenshots/agent-artifact-preview.webp -q 80
npx -y bun /Users/limbo/.config/agents/skills/baoyu-compress-image/scripts/main.ts "$HOME/Desktop/example2.png" -o apps/website/public/assets/screenshots/mcp-connectors.webp -q 80
npx -y bun /Users/limbo/.config/agents/skills/baoyu-compress-image/scripts/main.ts "$HOME/Desktop/example3.png" -o apps/website/public/assets/screenshots/skills-library.webp -q 80
```

- [ ] **Step 2: Verify dimensions, formats, and size reduction**

```bash
file apps/website/public/assets/screenshots/*.webp
sips -g pixelWidth -g pixelHeight apps/website/public/assets/screenshots/*.webp
du -ch "$HOME/Desktop"/example{1,2,3}.png | tail -1
du -ch apps/website/public/assets/screenshots/*.webp | tail -1
```

Expected: every WebP is 3152 × 2152 and the combined WebP size is smaller than the combined PNG size.

### Task 2: Add localized website screenshot presentation

**Files:**
- Modify: `apps/website/src/pages/index.astro:21`
- Modify: `apps/website/src/pages/zh/index.astro:21`
- Modify: `apps/website/src/styles/global.css`

**Interfaces:**
- Consumes: `/assets/screenshots/agent-artifact-preview.webp`, `/assets/screenshots/mcp-connectors.webp`, `/assets/screenshots/skills-library.webp`
- Produces: Responsive English and Chinese product-gallery sections.

- [ ] **Step 1: Add the English and Chinese gallery markup before each features section**

Use a `section.shell.section.product-showcase` containing a localized heading and a
`div.screenshot-grid`. The Agent workflow is an `article.screenshot-card.screenshot-card-primary`;
the MCP and Skills cards are standard `article.screenshot-card`. Every image must set
`width="3152"`, `height="2152"`, `loading="lazy"`, and localized `alt` text.

- [ ] **Step 2: Add shared responsive styling**

Add rules for `.product-showcase`, `.screenshot-grid`, `.screenshot-card`,
`.screenshot-card-primary`, `.screenshot-frame`, and screenshot captions. Use existing `--line`,
`--surface`, `--muted`, radii, and shadow conventions. Collapse the two-column grid in the existing
`@media (max-width: 800px)` block.

- [ ] **Step 3: Build the website**

```bash
bun run website:build
```

Expected: Astro exits successfully and generates English and Chinese pages.

### Task 3: Add screenshots to the repository README

**Files:**
- Modify: `README.md:33`

**Interfaces:**
- Consumes: `./apps/website/public/assets/screenshots/*.webp`
- Produces: A GitHub-renderable product walkthrough before the Features section.

- [ ] **Step 1: Add the screenshot walkthrough**

Add `## See Bitlab in action`, a full-width Agent workflow image, and a two-column HTML table for
the MCP and Skills images. Use short descriptions and descriptive alt text.

- [ ] **Step 2: Verify all references and tracked output**

```bash
rg -n "agent-artifact-preview|mcp-connectors|skills-library" README.md apps/website/src/pages/index.astro apps/website/src/pages/zh/index.astro apps/website/dist/index.html apps/website/dist/zh/index.html
git status --short
```

Expected: each source page and built localized page references all three images; status contains only
the intended plan, screenshot assets, website source, generated build changes if tracked, and README,
plus pre-existing unrelated documentation edits.
