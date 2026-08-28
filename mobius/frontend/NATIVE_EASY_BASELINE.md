# Native easy-mode baseline

The isolated easy-mode source tree under `src/native-easy/` is a byte-for-byte
snapshot of commit `99e3b3e4` (also identical to
`backup/feat-native-provider-cli-support-before-main-fork-history-merge-20260829`).

That snapshot contains two different simplified surfaces. The preserved native
easy mode is the Workbench route at `/u/:user` (project folders, `Home`, and the
Workbench composer), not the later `/u/:user/easy_mode` "工作导航" page. The
entry bridge intentionally translates the public easy-mode URL to the Workbench
route and keeps session/issue navigation reversible.

Keep regular-mode code aligned with `main-fork`. Do not edit the snapshot in
place; update it only by intentionally choosing a new native easy-mode baseline
and updating `scripts/verify-ui-mode-baselines.mjs` in the same change.
