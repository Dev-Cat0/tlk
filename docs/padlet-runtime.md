# Padlet browser runtime

The 512 MiB Render runner was killed for exceeding its memory limit when it held multiple live Padlet pages. Padlet now queues browser operations and keeps only one board page open. Guest contexts remain isolated, retaining their own cookies and local storage; switching guests closes the previous page and loads the next guest's board. The total post limit and bot count are unchanged. Configured intervals are lower bounds, not guaranteed throughput: page loads and queued work add time.

Navigation and board readiness each allow up to 90 seconds. Images, media and web fonts are skipped; scripts, styles and API requests are retained. Publication is never automatically retried after an ambiguous result.

For diagnostics, `/api/start` accepts `checkOnly: true` in an otherwise normal Padlet config. It prepares every guest, records readiness and closes all sessions without calling `send`. It uses the normal single-job lock and `/api/stop`. The default is false; non-boolean values are rejected. This checks board access, not successful publication.

Run `node --test test/padlet.test.mjs test/padlet.browser.test.mjs` with `BROWSER_TESTS=1` and an installed Playwright Chromium. The browser tests use intercepted fixtures and never post to Padlet. They check single-page concurrency, guest cookie separation, queue cancellation, slow readiness, essential-resource loading and publication confirmation.
