[← Back to README](../../README.md)

# Desktop widget

`opencode-quota widget` opens a small, always-on-top desktop window that keeps your
remaining quota visible while you work. It is the fastest way to watch OpenCode Go's
**5-hour**, **weekly**, and **monthly** windows at the same time:

```
┌─────────────────────────────┐
│ Quota                     × │
│ OpenCode Go                 │
│ 5h       ██████████░░  97%  │
│ Weekly   █████████░░░  88%  │
│ Monthly  ███████░░░░░  64%  │
│                 updated 12:34│
└─────────────────────────────┘
```

## Quick start

```bash
npx @slkiser/opencode-quota@latest widget
```

The window opens in the **top-right** corner and refreshes every 60 seconds. Drag the
title bar to move it; the position is remembered for next time. Click **×** to close.

## Options

| Option                    | Default             | What it does                                                    |
| ------------------------- | ------------------- | --------------------------------------------------------------- |
| `--position <corner>`     | `top-right`         | Initial corner: `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `--provider <id>`         | all enabled         | Show only one provider, for example `opencode-go`               |
| `--interval <seconds>`    | `60`                | How often the snapshot is refreshed                             |
| `--margin <px>`           | `16`                | Screen margin used for the initial corner                       |
| `--alpha <0..1>`          | `0.94`              | Window opacity                                                  |
| `--x <px>` `--y <px>`     | unset               | Explicit initial position; overrides `--position` and saved drag |
| `--title <text>`          | `Quota`             | Header title                                                    |
| `--data <path>`           | XDG cache           | Snapshot file written for the overlay                           |
| `--state <path>`          | XDG state           | File that stores the dragged position                           |
| `--python <path>`         | `python3`           | Python interpreter (or set `OPENCODE_QUOTA_PYTHON`)             |
| `--print`                 | off                 | Print the snapshot JSON and exit without opening a window       |
| `--live`                  | off                 | Force a live provider fetch instead of the cached snapshot      |
| `--no-refresh`            | off                 | Write the snapshot once and keep the last data                  |

Examples:

```bash
# Pin OpenCode Go in the top-left corner and refresh every 30 seconds.
npx @slkiser/opencode-quota@latest widget --provider opencode-go --position top-left --interval 30

# Print the exact data the overlay renders (useful for scripting).
npx @slkiser/opencode-quota@latest widget --provider opencode-go --print
```

## Requirements

- **Python 3** with **tkinter** (bundled with python.org builds; on Debian/Ubuntu install
  `python3-tk`, on Fedora `python3-tkinter`).
- A desktop session. On Wayland the window runs through XWayland; some compositors may
  require you to allow focus/positioning for legacy X11 windows.

If no display is available the command fails with `cannot open display` and exits with
code 2.

## How it works

1. `widget` collects quota with the same provider pipeline as `opencode-quota show`,
   always requesting every OpenCode Go window.
2. It writes a small snapshot to the XDG cache (`quota-widget.json`) and refreshes it on
   `--interval`.
3. The Python overlay reads that snapshot and redraws only when the file changes. It
   never contacts providers itself.

Because the overlay only reads the snapshot, you can also point `--data` at the file
written by [`export`](configuration.md) or any other tool that produces the same shape.

## Keep it running

Start the widget once per login with your platform's service manager. For example, a
systemd user unit:

```ini
# ~/.config/systemd/user/opencode-quota-widget.service
[Unit]
Description=OpenCode Quota desktop widget
After=graphical-session.target

[Service]
ExecStart=/usr/bin/npx -y @slkiser/opencode-quota@latest widget
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-quota-widget.service
```

## GNOME top panel (taskbar)

A bundled GNOME Shell extension renders the same OpenCode Go data as a single top-panel
line, for example `Go 5h 95%  7d 87%  30d 63%`, with each window colored green / amber /
red by how much is left. Clicking it opens a menu with the same colored rows, reset
countdowns, **Panel position**, **Refresh interval**, and **Refresh now**.

- Refresh defaults to every 30 seconds and can be changed in the menu to 1 or 5 minutes;
  clicking also refreshes when the data is older than 30 seconds.
- Each refresh runs `opencode-quota widget --provider opencode-go --print --live`, which
  queries the provider usage API directly. It never sends inference tokens.
- GNOME does not support dragging status-area items, so use **Panel position** to move the
  label between the left edge, center, and right edge. The choices are remembered in
  `~/.config/opencode-quota/panel.json`.

```bash
# Install the extension into ~/.local/share/gnome-shell/extensions
corepack pnpm run install:gnome-extension

# Enable it once
gnome-extensions enable opencode-quota@local
```

It refreshes by running `opencode-quota widget --provider opencode-go --print --live`
(live provider data, no window). GNOME Shell caches extension modules, so after changing
`gnome-extension/opencode-quota@local/extension.js` you must log out and back in
(Wayland) or restart the shell (X11) to load the new code.

## Troubleshooting

- **Window never appears**: confirm `python3 -c "import tkinter"` succeeds and that a
  desktop session is running.
- **Wrong corner or off-screen**: pass `--x` and `--y`, or delete the state file named in
  `--state` and restart.
- **No quota rows**: run `opencode-quota show` first to make sure the provider is detected
  and authenticated; the overlay shows `waiting for quota data…` until the first snapshot
  arrives.
