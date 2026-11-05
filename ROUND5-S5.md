# Round 5 · Faucet implementation

Local only on `lab/unified`; no push, deployment, PR or production write.

| Reviewer item | Result |
| --- | --- |
| Sol 22 · failed status diagnostics | Fixed: distinguish unknown availability from a confirmed outage, show the UTC failed-check time and last successful check (or say there has been none), retain the address, disable requests until a successful retry. Successful observations carry their check time. |
| Opus developer journey · Mainnet detour | Fixed: Mainnet invitation links are hidden throughout Bridge/Start funding, including before status loads and after a retry. Mainnet invitations remain available from the general Faucet entry. |
| Opus 22 · short-page footers | Fixed on the Faucet and account/admin pages using a full-height flex layout. |
| Opus 25 · links | Existing family underline and offset retained. |

Before: `reviews/round4-sol-shots/faucet-phone.png` in the lab root, captured on
reviewed head `e0c1a74375441865d00eb4da7a647a55e5e247f5`.
After: `../bridge/.lab-r5/evidence/faucet-status-unknown-phone-light.png` and
`faucet-handoff-phone-light.png`, with all four device/theme variants beside them.
The failure image deliberately aborts the status read; it is not a claim about
live service downtime. The funding image uses a disposable public address.
Historical and current chain numbers are not controlled fixtures.
Standard screenshots: `shots/r5-s5/faucet/` in the lab root.

Validation: 297 unit/Worker tests, 19 browser tests, and both TypeScript project
checks pass. Browser coverage includes failed status → successful retry → failed
refresh with last-success context, unchanged receiving address, disabled payout
control, and no Mainnet detour despite invitations being enabled. Mock CAPTCHA
and payout tests remain explicit fixtures; no live payout is attempted. JavaScript
syntax and diff whitespace checks pass; there is no separate lint command.

Guarded lab QA uses `lab/qa-guard.mjs`, service workers blocked, 390px true-mobile
and 1440px desktop, both themes. It verifies exact Bridge address handoff,
return/resume links and the safe backup recovery path. Direct review found no
unresolved correctness or security findings. Price, key handling and CSP were not
changed.
