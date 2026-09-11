#!/usr/bin/env python3
"""Always-on-top desktop quota overlay for opencode-quota.

The Node CLI (`opencode-quota widget`) keeps a JSON snapshot fresh on disk and
spawns this process. The overlay polls that file and redraws whenever it
changes, so the widget never talks to providers directly.

Usage:
    python3 overlay.py --data <snapshot.json> [options]

Options:
    --data <path>        JSON snapshot written by the Node CLI (required)
    --interval <sec>     Poll interval for snapshot changes (default: 60)
    --position <corner>  top-right | top-left | bottom-right | bottom-left
    --state <path>       JSON file used to persist the dragged position
    --margin <px>        Screen margin for the initial corner placement
    --alpha <0..1>       Window opacity (default: 0.94)
    --x <px> --y <px>    Explicit initial position; overrides --position
    --title <text>       Header title (default: Quota)
    --once               Render once and exit (used for smoke tests)
    --no-gui             Validate arguments and snapshot, then exit
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import tkinter as tk
from typing import Any

CARD_BG = "#1b1e24"
HEADER_BG = "#22262e"
TRACK_BG = "#31353d"
TEXT = "#e6e8eb"
MUTED = "#8b919c"
GREEN = "#3fb950"
AMBER = "#d29922"
RED = "#f85149"
BORDER = "#3a3f48"

BAR_WIDTH = 96
BAR_HEIGHT = 8
BAR_CELLS = 24
POLL_MIN_MS = 1000


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True, description="OpenCode quota overlay")
    parser.add_argument("--data", required=True)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--position", default="top-right")
    parser.add_argument("--state", default="")
    parser.add_argument("--margin", type=int, default=16)
    parser.add_argument("--alpha", type=float, default=0.94)
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    parser.add_argument("--title", default="Quota")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-gui", action="store_true")
    return parser.parse_args(argv)


def load_json(path: str) -> Any | None:
    if not path:
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def write_json_atomic(path: str, payload: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".quota-widget-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def percent_color(percent: float) -> str:
    if percent < 20.0:
        return RED
    if percent < 50.0:
        return AMBER
    return GREEN


def clamp_percent(value: Any) -> float:
    if not isinstance(value, (int, float)):
        return 0.0
    return max(0.0, min(100.0, float(value)))


def format_percent(value: float) -> str:
    rounded = int(round(value))
    return f"{rounded}%"


def format_reset(reset_at: Any) -> str:
    if not isinstance(reset_at, (int, float)) or reset_at <= 0:
        return ""
    import time

    remaining = int(reset_at - time.time())
    if remaining <= 0:
        return "reset"
    if remaining >= 86400:
        return f"{remaining // 86400}d"
    if remaining >= 3600:
        return f"{remaining // 3600}h"
    if remaining >= 60:
        return f"{remaining // 60}m"
    return f"{remaining}s"


class Overlay:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = tk.Tk()
        self.root.title("OpenCode Quota")
        self.root.overrideredirect(True)
        self.root.configure(bg=CARD_BG)
        self._configure_window()
        self._mtime: float | None = None
        self._dragging = False
        self._drag_offset = (0, 0)
        self._pinned = False

        self.card = tk.Frame(self.root, bg=CARD_BG, highlightthickness=1, highlightbackground=BORDER)
        self.card.pack(fill="both", expand=True)

        self.header = tk.Frame(self.card, bg=HEADER_BG)
        self.header.pack(fill="x")
        self.title_label = tk.Label(
            self.header,
            text=args.title,
            bg=HEADER_BG,
            fg=TEXT,
            font=("DejaVu Sans", 9, "bold"),
            anchor="w",
            padx=10,
            pady=5,
        )
        self.title_label.pack(side="left")
        self.close_label = tk.Label(
            self.header,
            text="\u00d7",
            bg=HEADER_BG,
            fg=MUTED,
            font=("DejaVu Sans", 11, "bold"),
            padx=8,
            cursor="hand2",
        )
        self.close_label.pack(side="right")
        self.close_label.bind("<Button-1>", lambda _event: self.close())

        self.body = tk.Frame(self.card, bg=CARD_BG)
        self.body.pack(fill="both", expand=True)

        self.footer = tk.Label(
            self.card,
            text="",
            bg=CARD_BG,
            fg=MUTED,
            font=("DejaVu Sans", 7),
            anchor="e",
            padx=10,
            pady=2,
        )
        self.footer.pack(fill="x")

        for widget in (self.header, self.title_label):
            widget.bind("<Button-1>", self._start_drag)
            widget.bind("<B1-Motion>", self._on_drag)
            widget.bind("<ButtonRelease-1>", self._end_drag)

        self._place_initial()

    def _configure_window(self) -> None:
        try:
            self.root.attributes("-topmost", True)
        except tk.TclError:
            pass
        try:
            self.root.attributes("-alpha", max(0.2, min(1.0, self.args.alpha)))
        except tk.TclError:
            pass

    def _place_initial(self) -> None:
        self.root.update_idletasks()
        state = load_json(self.args.state) if self.args.state else None
        if isinstance(state, dict) and isinstance(state.get("x"), int) and isinstance(state.get("y"), int):
            self.root.geometry(f"+{state['x']}+{state['y']}")
            self._pinned = True
            return
        if self.args.x is not None and self.args.y is not None:
            self.root.geometry(f"+{self.args.x}+{self.args.y}")
            self._pinned = True
            return
        self._place_corner(self.args.position)

    def _place_corner(self, position: str) -> None:
        self.root.update_idletasks()
        width = max(self.root.winfo_reqwidth(), 180)
        height = max(self.root.winfo_reqheight(), 60)
        screen_w = self.root.winfo_screenwidth()
        screen_h = self.root.winfo_screenheight()
        margin = max(0, self.args.margin)
        right = screen_w - width - margin
        bottom = screen_h - height - margin
        positions = {
            "top-right": (right, margin),
            "top-left": (margin, margin),
            "bottom-right": (right, bottom),
            "bottom-left": (margin, bottom),
        }
        x, y = positions.get(position, positions["top-right"])
        self.root.geometry(f"+{max(0, x)}+{max(0, y)}")

    def _start_drag(self, event: tk.Event) -> None:
        self._dragging = True
        self._drag_offset = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())

    def _on_drag(self, event: tk.Event) -> None:
        if not self._dragging:
            return
        x = event.x_root - self._drag_offset[0]
        y = event.y_root - self._drag_offset[1]
        self.root.geometry(f"+{max(0, x)}+{max(0, y)}")

    def _end_drag(self, _event: tk.Event) -> None:
        self._dragging = False
        if self.args.state:
            try:
                write_json_atomic(
                    self.args.state,
                    {"x": max(0, self.root.winfo_x()), "y": max(0, self.root.winfo_y())},
                )
            except OSError:
                pass

    def _clear_body(self) -> None:
        for child in self.body.winfo_children():
            child.destroy()

    def _add_provider(self, provider: dict[str, Any]) -> None:
        name = provider.get("name") or provider.get("id") or "Provider"
        label = tk.Label(
            self.body,
            text=str(name),
            bg=CARD_BG,
            fg=TEXT,
            font=("DejaVu Sans", 9, "bold"),
            anchor="w",
            padx=10,
            pady=4,
        )
        label.pack(fill="x")

        windows = provider.get("windows") or []
        if not windows:
            empty = tk.Label(
                self.body,
                text="no quota data",
                bg=CARD_BG,
                fg=MUTED,
                font=("DejaVu Sans", 8),
                anchor="w",
                padx=12,
            )
            empty.pack(fill="x")
            return

        rows = tk.Frame(self.body, bg=CARD_BG)
        rows.pack(fill="x", padx=10, pady=(0, 3))
        for index, window in enumerate(windows):
            percent = clamp_percent(window.get("percentRemaining"))
            window_label = str(window.get("label") or window.get("window") or "Quota")
            reset = format_reset(window.get("resetAt"))
            suffix = f"  {reset}" if reset else ""

            tk.Label(
                rows,
                text=window_label,
                bg=CARD_BG,
                fg=MUTED,
                font=("DejaVu Sans", 8),
                width=8,
                anchor="w",
            ).grid(row=index, column=0, sticky="w", pady=1)

            canvas = tk.Canvas(
                rows,
                width=BAR_WIDTH,
                height=BAR_HEIGHT,
                bg=CARD_BG,
                highlightthickness=0,
            )
            canvas.grid(row=index, column=1, sticky="w", padx=(2, 6))
            canvas.create_rectangle(0, 0, BAR_WIDTH, BAR_HEIGHT, fill=TRACK_BG, outline="")
            filled = int(round((percent / 100.0) * BAR_WIDTH))
            if filled > 0:
                canvas.create_rectangle(0, 0, filled, BAR_HEIGHT, fill=percent_color(percent), outline="")

            tk.Label(
                rows,
                text=f"{format_percent(percent)}{suffix}",
                bg=CARD_BG,
                fg=percent_color(percent),
                font=("DejaVu Sans", 8, "bold"),
                anchor="e",
            ).grid(row=index, column=2, sticky="e")

    def render(self, payload: Any) -> None:
        self._clear_body()
        providers = []
        if isinstance(payload, dict):
            raw = payload.get("providers")
            if isinstance(raw, list):
                providers = [item for item in raw if isinstance(item, dict)]

        if not providers:
            tk.Label(
                self.body,
                text="waiting for quota data\u2026",
                bg=CARD_BG,
                fg=MUTED,
                font=("DejaVu Sans", 8),
                anchor="w",
                padx=12,
                pady=6,
            ).pack(fill="x")
        else:
            for provider in providers:
                self._add_provider(provider)

        generated = payload.get("generatedAt") if isinstance(payload, dict) else None
        if isinstance(generated, (int, float)) and generated > 0:
            import time

            stamp = time.strftime("%H:%M:%S", time.localtime(generated))
            self.footer.configure(text=f"updated {stamp}")
        else:
            self.footer.configure(text="")
        self.root.update_idletasks()

    def _poll(self) -> None:
        try:
            mtime = os.path.getmtime(self.args.data)
        except OSError:
            mtime = None
        if mtime != self._mtime:
            self._mtime = mtime
            self.render(load_json(self.args.data))
        interval_ms = max(POLL_MIN_MS, int(self.args.interval * 1000))
        self.root.after(interval_ms, self._poll)

    def close(self) -> None:
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def run(self) -> int:
        self.render(load_json(self.args.data))
        if not self._pinned:
            self._place_corner(self.args.position)
        try:
            self._mtime = os.path.getmtime(self.args.data)
        except OSError:
            self._mtime = None
        self._poll()
        self.root.mainloop()
        return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.no_gui:
        payload = load_json(args.data)
        return 0 if isinstance(payload, dict) else 1
    try:
        overlay = Overlay(args)
    except tk.TclError as error:
        print(f"opencode-quota widget: cannot open display: {error}", file=sys.stderr)
        return 2
    if args.once:
        overlay.render(load_json(args.data))
        overlay.close()
        return 0
    return overlay.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
