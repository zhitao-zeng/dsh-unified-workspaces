# Third-party notices

The integration code is MIT licensed. See LICENSE.

## DeepSeek Harness directory browser

`lib/picker.js` and its embedded client derivative are derived from
`@deepseek-ai/dsh-client-ui-directory-picker-browse` version 0.2.1-rc.5.
Copyright (c) 2026 DeepSeek. MIT; full text: `licenses/DeepSeek-MIT.txt`.
The derivative changes its module and locale identifiers, slot priorities,
and the directory dialog title. The upstream library was obtained from the
signed official DeepSeek Harness application.

## clsx 2.1.1

The derived directory browser includes the clsx implementation.
Copyright (c) Luke Edwards. MIT; full text: `licenses/clsx-MIT.txt`.
Upstream: https://github.com/lukeed/clsx/tree/v2.1.1

## SSH workspace architecture reference

The persistent native frontend and unified project navigation design was
informed by https://github.com/sincerity711/dsh-ssh-workspace at commit
`5d5969157886421cd948163b4eff0a37acc7e404`.
Copyright (c) 2026 i060912. MIT; full text:
`licenses/dsh-ssh-workspace-MIT.txt` (also retained as `reference-LICENSE`).
This project uses existing remote DSH instances and does not run the
reference project's remote installation or environment synchronization.
