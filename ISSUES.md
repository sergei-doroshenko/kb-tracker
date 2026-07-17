# Issues & Tech Debt

## Architecture

### 1. Single 1829-line file
`src/App.jsx` contains the entire app: components, plan data, timer logic, and
the LLM prompt. Hard to navigate, review, or test in isolation.

**Recommendation:** Extract into modules — plan data, `genSets`, timer logic,
each tab component, and the LLM prompt as separate files. The architecture stays
flat but becomes reviewable.

### 2. Mutable module constants for state
`WEEKS`, `EX`, `GYM_EX` are mutated in place; React re-render is forced by a
dummy `planVer` counter. Fragile; breaks if anything caches stale references.

**Recommendation:** Move plan data into React Context or Zustand.

### 3. Side effects in `useState` updaters
`beep()` and `markDone()` inside `setTm` are acknowledged as a prototype
trade-off (double-fires in StrictMode).

**Recommendation:** Move timer side effects into a `useEffect` or a reducer with
a side-effect channel.

## Testing

### 4. No tests
No test framework is configured. `genSets()` and `buildPreset()` are pure
functions and obvious first candidates.

**Recommendation:** Add Vitest with table-driven tests for `genSets()` and
`buildPreset()` (one case per method variant).

## Reliability

### 5. No error boundaries
A corrupted JSON in localStorage crashes the whole app on load. Storage reads
are partially guarded with try/catch, but a render-time error is unhandled.

**Recommendation:** Add a top-level React error boundary with a "reset storage"
escape hatch.

### 6. localStorage only (~5 MB cap)
No migration strategy if the journal grows beyond the per-origin limit.

**Recommendation:** Migrate to IndexedDB (idb-keyval) for the journal; keep
localStorage for small config values (selected week, API key).

## UX / Progressive Enhancement

### 7. No PWA support
No service worker, no manifest, no Wake Lock. The screen can sleep mid-set;
the app doesn't work offline after the first load.

**Recommendation:** Add `vite-plugin-pwa` for offline support + Screen Wake Lock
API during active timer segments.

### 8. API key stored in localStorage without warning
Documented as acceptable for personal use only, but there's no in-app warning
if the page is served on a shared origin or public network.

**Recommendation:** Show a brief notice when a key is saved; suggest the
keyless "Prompt" path as the default.

## Accessibility

### 9. No ARIA labels or live regions
Interactive elements rely on visual color alone for state (done/skip/locked).
Timer controls and set buttons lack accessible names.

**Recommendation:** Add `aria-label` to icon-only buttons, `aria-live` regions
for timer announcements, and verify contrast ratios for the muted palette.
