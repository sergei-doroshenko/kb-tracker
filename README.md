# Kettlebell Journal

A training tracker for kettlebell sport: weekly plan (16→20 kg transition +
maintenance cycle), guided workouts with chained set timers, a journal with
CSV/JSON export, and plan import from markdown via the Claude API.

Note: the UI is in Russian (the product language); code comments and docs are in English.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
```

## Data

- Journal, selected week, and custom plan live in localStorage (keys prefixed
  `kbapp:`). Backups — the CSV/JSON export buttons in the Journal and Plan tabs.
- Plan import from text supports three paths: (1) manual prompt copy-paste
  (no key needed), (2) direct Anthropic API call from the browser (personal use
  only), (3) pasting ready-made JSON. See DEVELOPMENT.md §7 for details.

## Structure

- `src/App.jsx` — the entire app (tab components, exercise types, plan data);
  see the doc comment at the top of the file for the architecture overview.
- Storage: a `window.storage` shim over localStorage (Claude artifacts provide
  a native storage API — the code is compatible with both environments).

## Deployment & CI/CD

The app is deployed as a static SPA: private S3 bucket + CloudFront (HTTPS) +
GitHub Actions via OIDC (no long-lived keys).

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full setup: local dev, AWS
infrastructure, IAM roles, GitHub Actions workflow, and caching strategy.
