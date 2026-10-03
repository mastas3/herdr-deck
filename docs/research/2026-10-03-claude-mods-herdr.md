# Claude Mods and herdr integration — 2026-10-03

## Verified local findings

Linux runs Claude Code 2.1.287 and herdr 0.7.5. Its Teams profile (`~/.claude`) configures fable-guard, status-now, context-keeper, next-steps and fast-jev-compaction. Its Max profile (`~/.claude-mac`) configures the first three custom mods. The latest Claude session reports that Anthropic is refusing Max subscription access; this integration does not change account access.

At initial inspection, Linux `claude-mods` HEAD was `6347754` (add next-steps from the Mac set). The preceding updates replaced fleet-status/context-guard with context-keeper and retained Linux handoff/reload behavior. Tailnet-link was prepared but not yet installed on Linux; its operator permission prerequisite was pending. The stricter Linux fable-guard and Mac implementation remain distinct.

The Mac has the five custom mods as local directories, plus fast-jev-compaction as an installed plugin. The deck previously discarded public mod tokens and searched only `~/.claude/projects`. Native guards were already running inside Claude. The new integration keeps execution there, adds profile-aware reads/launch/resume, and exposes inventory, public signals, declared commands and native keyboard controls.

## Public documentation and existing solutions

Checked the maintainers' own pages, not installed or evaluated these applications:

| Project | What its documentation offers | Fit here |
| --- | --- | --- |
| [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui) | Browser/phone chat and live terminal, SSH machines, approvals, push alerts, PWA. Requires herdr 0.9.0+ on Linux/macOS. | Closest complete alternative to the deck. Linux currently has an older herdr. |
| [0cv/herdr-mobile-relay](https://github.com/0cv/herdr-mobile-relay) | Phone control, per-machine relays, notifications, multi-computer aggregation and explicit additional Claude profile directories. Supports herdr 0.7.5+. | Version 0.20.11 is already installed and enabled in Linux herdr; pairing/health was not audited. |
| [alecuba16/herdr-webui](https://github.com/alecuba16/herdr-webui) | Standalone browser terminal UI with built-in backend by default and external herdr sockets, desktop/mobile layouts, Git/files, terminal renderer choice. | Stronger full-terminal option, a larger application than this dependency-free deck. |
| [kcosr/herdr-web](https://github.com/kcosr/herdr-web) | Web client/bridge with terminal attachment, live snapshot/events and shared selection. | Another browser terminal implementation to evaluate if full attach is needed. |
| [dcolinmorgan/herdr-remote](https://github.com/dcolinmorgan/herdr-remote) | Menu-bar, web/phone and Telegram monitoring/control, approvals and digest. | Alternative remote access product; no tunnel or notification service was enabled here. |

[Anthropic's Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) says mods run in the Claude process, while their UI draws in terminal/Desktop surfaces. The docs now state that 2.1.287+ ignores the old `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` opt-in; the deck therefore does not interpret that variable as proof of runtime support or edit rollout flags. `/plugin` is the session's loaded-mod check and `/reload-plugins` applies shell-side updates.

[Herdr's socket API](https://herdr.dev/docs/socket-api/) documents metadata, key input and process-launch environment overrides. The installed Linux schema was also inspected: `tab.create` accepts `env`, while `agent.start` does not. The integration uses that supported launch path. No herdr upgrade/restart, arbitrary mod execution in the web server, public tunnel, or Tailscale 8448 change is required.

## Implementation and verification — 2026-10-04

The built-in `claude-mods` deck plugin is deployed and enabled on the Mac hub and Linux node. Live hub reads confirmed both Linux profiles, profile-specific `/progress`, `/handoff-compact` and `/next` command hints, and public context/cache/account signals. Only deck services were restarted; existing Claude panes were preserved. Linux's previous touched files were backed up under `~/.config/herdr-deck/backups/` before deployment.

The full Bun suite passed 1,329 tests. Focused profile/launcher/plugin checks passed on Linux (11 tests). Eight desktop/phone Mods scenarios and six plugin-off scenarios had no page errors; synthetic controls checked native key sequences, remote routing and stale-session protection without prompting a live model. The session inspector displays ANSI/text output and keyboard controls; graphics and mouse-only mod surfaces still need Claude's native terminal.

## Tailnet-link follow-up — 2026-10-04

After the owner ran the prerequisite command, a read-only check confirmed Tailscale `OperatorUser` is `stas`. Linux `claude-mods` is now at `beaf759`, adding tailnet-link unchanged from the Mac. Version 0.1.0 is installed and enabled in both Teams and Max profiles, and the deck inventory exposes `/links` for both. The Linux repository records Node inspector ports 9229 and 9230 as excluded. This check did not create a Serve route or send commands to an existing Claude session; configured state does not establish whether an older session has reloaded the mod.
