# Padlet browser runtime

The 512 MiB Render runner was killed for exceeding its memory limit when it held multiple live Padlet pages. Padlet now queues browser operations and keeps only one browser context and board page open. Each guest's cookies, local storage and IndexedDB state are saved separately in memory; switching guests closes the entire previous context and restores the next guest's storage before loading its board. Closing only the page retained too much context memory. The total post limit and bot count are unchanged. Configured intervals are lower bounds, not guaranteed throughput: page loads and queued work add time.

Navigation and board readiness each allow up to 90 seconds. Images, media and web fonts are skipped; scripts, styles and API requests are retained. Publication is never automatically retried after an ambiguous result.

After Publish, first-time guests may see Padlet's guest-name form while the composer remains open. The adapter waits for either that form or the composer closing, confirms the suggested guest name (uses `Guest` only when empty), then waits for the composer to close and new content to appear. It never clicks Publish twice. Both Korean and English Done labels are covered by delayed-modal fixtures, including a stalled submission and subsequent posts without a modal. A manual `dd`/`dd` post on the reported board reproduced this form and completed after Done; this is separate from a deployed-runner posting test.

For diagnostics, `/api/start` accepts `checkOnly: true` in an otherwise normal Padlet config. It prepares every guest, records readiness and closes all sessions without calling `send`. It uses the normal single-job lock and `/api/stop`. The default is false; non-boolean values are rejected. This checks board access, not successful publication.

Run `node --test test/padlet.test.mjs test/padlet.browser.test.mjs` with `BROWSER_TESTS=1` and an installed Playwright Chromium. The browser tests use intercepted fixtures and never post to Padlet. They check single-page concurrency, guest cookie separation, queue cancellation, slow readiness, essential-resource loading and publication confirmation.
