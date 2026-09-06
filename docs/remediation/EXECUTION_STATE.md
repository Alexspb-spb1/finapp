# Execution checkpoint

Updated: 2026-09-06. Status: IN_PROGRESS.

- Scope: existing stabilization stages 0–8, starting SEC-006 Stage 6;
  product stage 9 excluded. Owner's FINAPP_ASTRA_HANDOFF.md and accompanying
  authorization supersede historical per-task manual stops in CLAUDE.md.
- Task: SEC-006 Stage 6 invitation management UI.
- Worktree: `D:/projects/finapp/finapp-sec006-stage6`.
- Branch: `remediation/SEC-006-stage-6-invitation-ui`.
- Base: `ff0ed1695f25e5cdb55b9cb9df8c35119b5164b0` (origin/main after fetch).
- Head: base, implementation in progress; PR: not created.
- Independent review: NOT YET RUN. No Stage 6 PASS claimed.
- Verified starting state: clean source worktrees, correct origin, no open PRs;
  PRs 23/24 integrated in main. Main CI successful:
  https://github.com/Alexspb-spb1/finapp/actions/runs/34021058008.
- Baseline defect: Users.tsx add form passes an admin-chosen password to
  authStore.inviteUser; this calls accounts:signUp and writes users/{uid}.
  No invitation-management UI exists. App uses HashRouter and Vite base /finapp/.
- Next: replace legacy invitation flow, test company/session isolation and
  transient links; mandatory CI, independent review, scoped Draft PR.
- External blocker: `.github/workflows/deploy.yml` automatically publishes
  GitHub Pages after successful main push CI. A merge therefore causes an
  external deployment and requires the concrete section-8 release package
  and owner approval before execution. Do not disable deployment/checks.
- Other external gates: Functions/Rules deployment, real verification email,
  staging/production rehearsal NOT authorized or executed. Stage 7 accept
  page is not implemented. SEC-006 remains open.
- SEC-005 membership migration is complete; do not repeat it.

On resume: fetch/check GitHub and exact HEAD, then inspect working diff.
Do not interpret old report banners as current merge/deployment state.
