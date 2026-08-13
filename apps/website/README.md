# Bitlab Website

The bilingual Bitlab product website is a fully static Astro application.

## Routes

- `/` — English home
- `/zh/` — Simplified Chinese home
- `/privacy/` and `/zh/privacy/`
- `/terms/` and `/zh/terms/`

## Development

Run from the repository root:

```bash
bun run website:dev
bun run website:build
```

The production build is written to `apps/website/dist`. Cloudflare Workers
Static Assets serves that directory using `wrangler.jsonc`; the site does not
use a Worker script or server-side rendering.
