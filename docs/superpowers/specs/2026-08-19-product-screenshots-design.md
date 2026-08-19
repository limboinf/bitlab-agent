# Product screenshots design

## Goal

Publish the three real Bitlab screenshots currently named `example1.png`, `example2.png`, and
`example3.png` on the bilingual product website and in the repository README. Preserve each full
screenshot, including its desktop wallpaper, while reducing download and repository size.

## Assets

- Convert the three PNG files to WebP at a visually suitable quality for product screenshots.
- Preserve their original 3152 × 2152 dimensions and aspect ratio; do not crop the wallpaper.
- Store one shared copy of each image under `apps/website/public/assets/screenshots/` so Astro serves
  them directly and the root README can reference the same tracked files.
- Use descriptive filenames for the demonstrated workflows: Agent artifact preview, MCP connectors,
  and Skills library.

## Website presentation

Add a responsive product-screenshot section to both the English and Simplified Chinese home pages.
The Agent workflow screenshot is the primary, full-width image. The MCP connectors and Skills
screenshots follow as two supporting cards. Each image has localized explanatory copy and useful alt
text. The section uses the website's existing colors, borders, radii, shadows, spacing, and responsive
breakpoint rather than introducing new design tokens.

The existing illustrated `ProductWindow` remains in the hero. Real screenshots are placed lower on
the page where they can explain actual product capabilities without making the first page load or
hero composition depend on three large images.

## README presentation

Add a concise “See Bitlab in action” section after the introductory product description and before
the feature list. Show the Agent workflow screenshot prominently, followed by the connector and
Skills screenshots side by side using GitHub-compatible HTML. Include short labels that explain what
each screenshot demonstrates.

## Verification

- Compare source and compressed dimensions and file sizes.
- Build the Astro website with `bun run website:build`.
- Confirm generated English and Chinese pages reference all three screenshots.
- Check that the README image paths resolve to tracked files.
