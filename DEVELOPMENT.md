# DEVELOPMENT.md — development and deployment

Project: a single-page React kettlebell training tracker. Code is hosted on
GitHub; deployment is GitHub Actions → AWS S3 (+ CloudFront). There is no
backend: all persistence lives in the browser's localStorage.

Note: the UI is intentionally in Russian (the product language). Code comments,
docs, and infrastructure are in English.

## 1. Prerequisites

- Node.js ≥ 20 (LTS): https://nodejs.org
- npm ≥ 10 (ships with Node)
- AWS CLI v2 (for one-time infrastructure setup): https://docs.aws.amazon.com/cli/
- GitHub and AWS accounts

## 2. Local development

```bash
npm install
npm run dev        # Vite dev server: http://localhost:5173, HMR out of the box
npm run build      # production build into dist/
npm run preview    # serve dist/ locally — verify the actual build
```

Stack: Vite 5 (https://vitejs.dev), React 18 (https://react.dev),
Tailwind CSS 3 (https://tailwindcss.com/docs).

Configuration notes:
- `vite.config.js`: `base: './'` — relative asset paths, so the build works from
  the bucket root or any subdirectory (https://vitejs.dev/config/shared-options.html#base).
- `tailwind.config.js`: `content` points at index.html and src/**/*.jsx —
  only classes actually used end up in the build
  (https://tailwindcss.com/docs/content-configuration).
- The palette is defined via inline styles through the `C` constant object in
  App.jsx; Tailwind is used only for layout/spacing. The reason is historical
  (ported from a Claude artifact, where arbitrary Tailwind values are unavailable);
  it can be moved into `theme.extend.colors` if desired.

## 3. Code structure

```
src/
  main.jsx    — entry point, React mount
  App.jsx     — the ENTIRE app (see the large doc comment at the top of the file)
  index.css   — the three Tailwind directives
```

Key parts of App.jsx (details and links are in comments at each site):
- The `window.storage` shim over localStorage — Claude artifacts provide a native
  storage API; in the browser this shim covers it; the interface is identical.
- `WEEKS`, `EX`, `GYM_EX` — plan data; the exercise spec (t/s/c) is described in
  the file header and mirrored in `PLAN_PROMPT` for the LLM import.
- `genSets()` — unrolls a training method into an ordered sequence of sets.
- `Today` — the guided workout with the auto-chained sets (state machine in `acts`).
- `PlanView` — plan import/export; three paths: LLM with a key, manual prompt, raw JSON.

Journal entry format (localStorage `kbapp:kb-log`, an array):
```json
{ "id": 1720000000000, "date": "2026-07-13", "dow": 1, "week": "1",
  "dur": 45, "pre": {"well": 4, "sleep": 3, "energy": 4}, "feel": 4,
  "note": "…", "exercises": [
    {"n": "Рывок · метод 3 (интервалы)", "kg": 16, "uni": true, "r": "58", "l": "55"}
  ] }
```

## 4. GitHub: repository setup

```bash
git init
git add .
git commit -m "kb-tracker: initial"
git branch -M main
git remote add origin git@github.com:<you>/kb-tracker.git
git push -u origin main
```

`.gitignore` already excludes node_modules/, dist/ and .env*.
Workflow: changes go through branches; merging into `main` = production deploy
(the workflow triggers on push to main; manual runs via workflow_dispatch).

## 5. AWS: one-time infrastructure setup

Below is the minimal "proper" setup: private S3 + CloudFront (HTTPS) +
deployment from GitHub Actions via OIDC with no long-lived keys.

### 5.1 S3

```bash
aws s3 mb s3://kb-tracker-prod --region eu-central-1
```
The bucket stays private (Block Public Access is on by default) — CloudFront
serves it to the outside world.

### 5.2 CloudFront

AWS Console → CloudFront → **Create distribution**:

1. **Origin access**: choose **Origin access control settings (recommended)** →
   click **Create new OAC** → leave defaults (Sign requests, S3 origin type) → Create.
2. Leave Origin path blank (files are at the bucket root).
3. Under Origin settings and Cache settings, choose the "Use recommended…" options.
4. **Viewer protocol policy**: Redirect HTTP to HTTPS.
5. **Default root object**: `index.html`
6. Leave alternate domain names (CNAMEs) and custom SSL certificate blank — you'll
   get a working `*.cloudfront.net` URL. A custom domain can be added later.
7. Click **Create distribution**.

Docs: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
The app is a SPA without routing, so custom error responses (404→index.html) are not needed.

### 5.3 IAM: GitHub OIDC provider and the deploy role

Provider (once per account):
```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

Role `kb-tracker-deploy` with this trust policy (replace <ACCOUNT_ID> and <you>/kb-tracker):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": [
          "repo:<you>/kb-tracker:ref:refs/heads/main",
          "repo:<you>/kb-tracker:environment:production"
        ]
      }
    }
  }]
}
```
The `sub` condition pins the role to the main branch and the `production`
environment of your repository. Both are needed: GitHub uses the `ref:` format
for plain `push` triggers and the `environment:` format when the workflow
specifies `environment: production`.
Docs: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services

Permissions policy for the role (minimal):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::kb-tracker-prod" },
    { "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::kb-tracker-prod/*" },
    { "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DIST_ID>" }
  ]
}
```

### 5.4 GitHub repository settings

Settings → Secrets and variables → Actions:
- Secret `AWS_ROLE_ARN` = arn:aws:iam::<ACCOUNT_ID>:role/kb-tracker-deploy
- Variable `AWS_REGION` = eu-central-1
- Variable `S3_BUCKET` = kb-tracker-prod
- Variable `CLOUDFRONT_DISTRIBUTION_ID` = <DIST_ID> (leave empty — the invalidation step will be skipped)

Creating a `production` environment is recommended (Settings → Environments) — the workflow already references it; required reviewers can be enabled there.

## 6. CI/CD: how the deploy works

File: `.github/workflows/deploy.yml`. 
Push to main → checkout → Node 20 with npm cache → `npm ci` → `npm run build` →
OIDC auth to AWS → upload to S3 → CloudFront invalidation.

Caching strategy (key to instant updates):
- everything except index.html → `Cache-Control: public,max-age=31536000,immutable` —
  filenames contain content hashes (Vite), so they can be cached forever;
- index.html → `no-cache` + a targeted `/index.html` invalidation —
  a new deploy is picked up immediately, and the invalidation is effectively
  free (the first 1,000 paths per month are not billed).

Rollback: `git revert` the offending commit on main → CI deploys the previous version.

## 7. Data and privacy

- Journal/plan/week — localStorage prefixed `kbapp:` (bound to the origin);
  changing domains = a "fresh" app. Backups — the CSV/JSON export buttons.
- LLM plan import has three paths. (1) The "Промпт" (Prompt) button — the app
  assembles the prompt, you submit it to Claude manually and paste the JSON
  reply back: no key required, the recommended path. (2) An Anthropic API key
  in the field — a direct browser call with the
  `anthropic-dangerous-direct-browser-access` header
  (https://docs.claude.com/en/api/client-sdks#browser-usage); the key is stored
  in localStorage — acceptable ONLY for personal use on your own devices.
  (3) Pasting ready-made JSON directly.
- For a public multi-user variant the key must live server-side —
  a minimal proxy: Lambda + Function URL / API Gateway.

## 8. Roadmap out of the prototype (optional)

- Module-constant mutation for plan data → React Context or zustand.
- localStorage → IndexedDB (idb-keyval) as the journal grows.
- PWA: manifest + service worker (vite-plugin-pwa), Wake Lock API so the screen
  stays on during a set: https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API
- Tests: vitest + @testing-library/react; the first candidate is genSets()
  (a pure function, table-driven tests per method).
