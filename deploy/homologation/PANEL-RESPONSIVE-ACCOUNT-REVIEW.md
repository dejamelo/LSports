# Panel/API: responsive navigation and administrative sessions

Ready for API-only publication. No worker, queue, distribution, provider credential, production data or POSNET change was executed during development. No synthetic users or datasets are included in the publication archive.

## Verified locally

- Existing layouts reused for empty-platform read-only Web/Móvil/POS preview. Actual iframe width observed at desktop test viewport: Web 1251 px (nominal maximum 1440), Móvil 390 px, POS 480 px. Height adapts to available viewport; no zoom scaling. No client, operation, integration credential or ticket was created to open this preview. Feed-unavailable state remained explicit; no betting controls/admission enabled.
- Administrative sessions for both platform_admin and client_admin expire at 300 seconds on the server. GET/polling/reload never renew. The explicit same-origin, CSRF-protected activity endpoint renews only a still-valid session. Browser hook responds to trusted human events, including same-origin preview iframe interactions. BroadcastChannel + storage synchronize activity and logout across tabs; the server remains authoritative. Expired activity cannot revive a session.
- Account password form is reachable without selecting a client. It requires current/new/confirmation, supports show/hide, and uses the current authenticated actor. Successful change revokes every administrative session of that account; old cookies and password are rejected, other accounts remain valid. Audit data contains no password values. Provider/integration credentials and operation embed credentials are not rotated.
- Automatic mobile panel CSS/inline collapsible navigation at <=650 px. Login and internal flows tested at 360, 390, 430 px, with no page-wide horizontal overflow. Tables scroll in their own wrapper. Menu open/close, Escape, navigation, long labels, client form entry, account form, and cancel/accept native confirmation dialogs passed. Desktop at 1440 px retains the 245 px sidebar and 34px/38px main padding. No desktop layout rules were replaced.
- Keyboard-space handling tested by reducing viewport height to 380 px and scrolling focused forms/actions into view. This is a browser simulation, not validation of an actual phone keyboard, Safari, tablet/POS or printer.

Validation: full workspace build; 55 API/feed-store tests; empty-platform navigation browser suite; session/account/formats browser suite for both roles; mobile panel browser suite for all widths; 6 Node publication/source tests and 10 Python publication/rollback tests. All passed. Screenshots and JSON browser logs were produced with isolated accounts and databases.

## Short acceptance walkthrough after publication

1. Open `https://sportbook.apuestadeportiva.lat/control` at 360, 390 and 430 px. Verify login has no page-wide horizontal scroll. Log in with the EXISTING administrator. Open/close Menú and select sections; it must move content, never cover it. Check audit-table horizontal scroll stays inside the table.
2. Open Mi cuenta, fill fields and inspect show/hide and confirmation. With a second tab open, change your own password; both tabs must require login. Confirm the old password fails and the new one succeeds. Do not send either password in chat.
3. Log in in two tabs. Leave both without interaction for five minutes; automatic refresh must not prevent logout. Interaction in one tab should renew the shared session. Reload after expiry must still require email/password.
4. For an empty platform/no client selected, open Sportsbook and select Web/Móvil/POS. Check the iframe width/layout actually changes and remains read-only with feed unavailable. On desktop, verify the usual sidebar/grid and normal navigation.

## Publication and rollback

Use the existing `update-adl-api.mjs` from this exact committed source, with `--repo`, `--commit` and `--preserve-local-changes`. It backs up local tracked edits, sends only committed production source, creates protected online SQLite backups + hashes, checks schema compatibility, preserves administrators, and replaces only API. It checks installed source, HTTPS/API and protected containers. Existing Compose overrides, platform/feed volumes and data remain authoritative.

Failure after API replacement triggers the existing automatic image rollback. A manual rollback is also available through the SAME entrypoint: `--rollback /var/backups/adl-api-update-<backup-id>`, using the backup printed by publication. It pins the old local image, appends an API-only overlay to CURRENT metadata and verifies no non-API container changed. It never restores an old database, password or worker configuration. If manual rollback fails, it attempts to recover the previously current API. No image rebuild/pull or queue action is performed by rollback.

The delivered Mac command supports this through `ADL_PANEL_ROLLBACK`: leave it unset for publication; to revert, set it to the printed protected backup path and run the same command. Keep backups. A rollback returns previous API/UI behavior while preserving data created since the update.

## Follow-up: explicit read-only formats and installed-version evidence

- Read-only iframe starts with an allowlisted `format=web|mobile|pos` query value; the existing same-origin presentation messages still support switching without recreating the session. The parameter never selects permissions or enables betting. Direct links use `/control/sportsbook-preview?format=...`, require an authenticated administrator to retrieve data, and provide a return-to-panel link.
- All initial channel choices, direct links, empty-feed messaging and touch navigation passed at 360/390/430 px in isolated browser contexts with zero clients. Desktop layout, password change and 300-second idle/cross-tab tests also passed. Physical devices and production are not verified by these tests.
- Mobile form children now have bounded sizing/grid gaps, password controls wrap, and dialog bounds use available viewport height. `/control` and the preview shell send `Cache-Control: no-store`; hashed immutable assets remain unchanged in policy.
- Before mutation the updater emits `installed_before_update`: metadata commit, actual image ID and comparisons of installed responsive sources against 6efd8c8. Source comparisons alone do not prove which assets the browser received. Existing final verification checks installed source plus HTTPS asset equality.
- The updater saves the CURRENT Caddyfile privately and verifies byte equality after publication; it never edits/reloads Caddy. This preserves the recovered privateAdmin rule, including 179.216.86.138/32, as it exists at invocation. API-only rollback does not restore or replace Caddy configuration.
- No production malfunction attribution is made: the previously reported broken mobile formats were not reproduced locally. Publication-version evidence is still necessary. No provider request, worker restart, migration or POSNET action was executed.
