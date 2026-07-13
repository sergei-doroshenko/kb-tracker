# Kettlebell Journal

A training tracker for kettlebell sport: weekly plan (16→20 kg transition +
maintenance cycle), guided workouts with chained set timers, a journal with
CSV/JSON export, and plan import from markdown via the Claude API.

Note: the UI is in Russian (the product language); code comments and docs are in English.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173
```

## Build

```bash
npm run build      # static output in dist/
npm run preview    # verify the production build locally
```

## Deploying to AWS S3

Option 1 — quick (S3 static website hosting, HTTP):

```bash
aws s3 mb s3://my-kb-tracker --region eu-central-1
aws s3 website s3://my-kb-tracker --index-document index.html

# Allow public reads (required for website hosting):
aws s3api put-public-access-block --bucket my-kb-tracker \
  --public-access-block-configuration BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket my-kb-tracker --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::my-kb-tracker/*"
  }]
}'

npm run build
aws s3 sync dist/ s3://my-kb-tracker --delete
# URL: http://my-kb-tracker.s3-website.eu-central-1.amazonaws.com
```

Option 2 — recommended (CloudFront in front of a private bucket, HTTPS):
create a CloudFront distribution with the bucket as origin via Origin Access
Control, default root object = index.html. HTTPS becomes mandatory once you
add PWA features (service worker, wake lock). Updates: `aws s3 sync dist/ s3://... --delete`
plus `aws cloudfront create-invalidation --distribution-id XXX --paths "/*"`.

The app is a SPA without routing, so no 404→index.html redirect rules are needed.

For CI/CD via GitHub Actions, see DEVELOPMENT.md.

## Data

- The journal, selected week, and custom plan live in the browser's localStorage
  (keys prefixed `kbapp:`). Backups — the CSV/JSON export buttons in the Journal
  and Plan tabs.
- Plan import from text calls the Claude API directly from the browser: it needs
  an Anthropic API key (entered on the Plan tab, stored in localStorage).
  WARNING: a key in the browser is visible to anyone with access to the device
  and is sent with requests from your page. Acceptable for personal use on your
  own phone; not for a public site (use a small proxy backend instead, e.g.
  Lambda + API Gateway, that keeps the key server-side).
  The keyless path: the "Промпт" (Prompt) button assembles the full prompt for
  manual submission to Claude; pasting the JSON reply back applies it with no key.

## Structure

- `src/App.jsx` — the entire app (tab components, exercise types, plan data);
  see the doc comment at the top of the file for the architecture overview
- Storage: a `window.storage` shim over localStorage (Claude artifacts provide
  a native storage API — the code is compatible with both environments)
