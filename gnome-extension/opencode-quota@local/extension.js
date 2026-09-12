// OpenCode Quota top-panel indicator.
//
// Reads quota by shelling out to the local `opencode-quota` CLI
// (https://github.com/slkiser/opencode-quota). Nothing is sent anywhere by this
// extension itself; the CLI talks to the provider usage APIs with your own
// credentials.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOME = GLib.get_home_dir();

const CACHE_TOLERANCE_SECONDS = 30;

const DEFAULT_REFRESH_SECONDS = 30;
const REFRESH_OPTIONS = [
    {seconds: 30, label: '30 seconds'},
    {seconds: 60, label: '1 minute'},
    {seconds: 300, label: '5 minutes'},
];

const PANEL_BOXES = ['left', 'center', 'right'];
const PANEL_BOX_LABELS = {left: 'Left edge', center: 'Center', right: 'Right edge'};
const PANEL_STATE_FILE = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'opencode-quota', 'panel.json',
]);

function loadPanelState() {
    try {
        const [ok, contents] = GLib.file_get_contents(PANEL_STATE_FILE);
        if (ok) {
            const parsed = JSON.parse(new TextDecoder().decode(contents));
            return {
                box: PANEL_BOXES.includes(parsed.box) ? parsed.box : 'right',
                refreshSeconds: REFRESH_OPTIONS.some(option => option.seconds === parsed.refreshSeconds)
                    ? parsed.refreshSeconds
                    : DEFAULT_REFRESH_SECONDS,
            };
        }
    } catch (_e) {
        // Missing or malformed state falls back to the defaults.
    }
    return {box: 'right', refreshSeconds: DEFAULT_REFRESH_SECONDS};
}

function savePanelState(state) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(PANEL_STATE_FILE), 0o755);
        GLib.file_set_contents(PANEL_STATE_FILE, JSON.stringify(state));
    } catch (_e) {
        // State persistence is best-effort only.
    }
}

const SHORT_NAMES = {
    'opencode-go': 'Go',
    'opencode-zen': 'Zen',
    openai: 'OpenAI',
    copilot: 'Copilot',
    anthropic: 'Claude',
    openrouter: 'Router',
    'z.ai': 'Z.ai',
    zai: 'Z.ai',
    'zhipu-coding-plan': 'Zhipu',
    'kimi-for-coding': 'Kimi',
    deepseek: 'DeepSeek',
    'qwen-code': 'Qwen',
    minimax: 'MiniMax',
    'minimax-cn': 'MiniMax',
    synthetic: 'Synth',
    chutes: 'Chutes',
    cursor: 'Cursor',
    kilo: 'Kilo',
    nanogpt: 'NanoGPT',
    'ollama-cloud': 'Ollama',
    xai: 'Grok',
    'google-antigravity': 'AGY',
};

function cliCandidates() {
    const candidates = [GLib.build_filenamev(['opencode-quota'])];

    const optDir = GLib.build_filenamev([HOME, '.local', 'opt']);
    try {
        const enumerator = Gio.File.new_for_path(optDir).enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            candidates.push(GLib.build_filenamev([optDir, info.get_name(), 'bin', 'opencode-quota']));
        }
        enumerator.close(null);
    } catch (_e) {
        // Directory may not exist; PATH lookup below still applies.
    }

    candidates.push('/usr/local/bin/opencode-quota', '/usr/bin/opencode-quota');
    return candidates;
}

let cachedCliPath = null;

function resolveCliPath() {
    if (cachedCliPath && GLib.file_test(cachedCliPath, GLib.FileTest.IS_EXECUTABLE))
        return cachedCliPath;

    for (const candidate of cliCandidates()) {
        if (!candidate.includes('/')) {
            const found = GLib.find_program_in_path(candidate);
            if (found) {
                cachedCliPath = found;
                return found;
            }
            continue;
        }
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE)) {
            cachedCliPath = candidate;
            return candidate;
        }
    }
    return null;
}

function runCli(args) {
    return new Promise((resolve, reject) => {
        const cliPath = resolveCliPath();
        if (!cliPath) {
            reject(new Error('opencode-quota CLI not found'));
            return;
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        // gnome-shell's PATH does not include npm's global bin directory.
        const path = [
            GLib.build_filenamev([HOME, '.local', 'bin']),
            GLib.getenv('PATH') ?? '/usr/local/bin:/usr/bin:/bin',
        ].join(':');
        launcher.setenv('PATH', path, true);

        let proc;
        try {
            proc = launcher.spawnv([cliPath, ...args]);
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            let stdout = '';
            let stderr = '';
            try {
                [, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                reject(e);
                return;
            }
            resolve({code: p.get_exit_status(), stdout: stdout ?? '', stderr: stderr ?? ''});
        });
    });
}

const WINDOW_SHORT_NAMES = {
    rolling: '5h',
    five_hour: '5h',
    '5h': '5h',
    weekly: '7d',
    week: '7d',
    '7d': '7d',
    monthly: '30d',
    month: '30d',
    '30d': '30d',
    daily: '1d',
    day: '1d',
    yearly: '1y',
    year: '1y',
};

function shortName(providerId) {
    const raw = String(providerId ?? 'provider');
    if (SHORT_NAMES[raw])
        return SHORT_NAMES[raw];

    // Providers without a canonical id fall back to their display name
    // ("OpenCode Go" -> "opencode-go" -> "Go", "GitHub Copilot" -> "Copilot").
    const normalized = raw.toLowerCase().replace(/\s+/g, '-');
    if (SHORT_NAMES[normalized])
        return SHORT_NAMES[normalized];
    for (const [key, short] of Object.entries(SHORT_NAMES)) {
        if (normalized.includes(key))
            return short;
    }

    const head = normalized.split(/[-_.]/)[0];
    return head.charAt(0).toUpperCase() + head.slice(1, 6);
}

function shortWindowLabel(label) {
    const key = String(label ?? '').trim().toLowerCase();
    return WINDOW_SHORT_NAMES[key] ?? String(label ?? 'quota');
}

function formatPercent(percent) {
    return `${Math.round(percent)}%`;
}

function relativeTime(seconds) {
    if (seconds <= 0)
        return 'now';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days)
        return `${days}d ${hours}h`;
    if (hours)
        return `${hours}h ${minutes}m`;
    return `${Math.max(1, minutes)}m`;
}

function severityClass(percent) {
    if (percent < 20)
        return 'quota-critical';
    if (percent < 50)
        return 'quota-warn';
    return 'quota-ok';
}

// Convert the widget snapshot into something easy to render.
function parseSnapshot(payload) {
    const providers = [];
    for (const provider of payload.providers ?? []) {
        const providerId = provider.id ?? provider.name ?? 'provider';
        const entries = (provider.windows ?? []).map(window => {
            const percent = typeof window.percentRemaining === 'number' ? window.percentRemaining : null;
            const resetsIn = typeof window.resetAt === 'number'
                ? window.resetAt - Math.floor(Date.now() / 1000)
                : null;
            return {
                label: window.label ?? 'quota',
                percent,
                value: null,
                resetsIn,
            };
        });

        const percentEntries = entries.filter(e => e.percent !== null);
        const lowest = percentEntries.length
            ? percentEntries.reduce((a, b) => (b.percent < a.percent ? b : a))
            : null;

        providers.push({id: providerId, name: shortName(providerId), entries, lowest});
    }

    // Keep the CLI payload order: it is stable across refreshes, which matters
    // when several providers are tiled on one panel line.
    return {
        providers,
        exportedAt: typeof payload.generatedAt === 'number'
            ? Math.floor(payload.generatedAt / 1000)
            : null,
    };
}

const QuotaPanelButton = GObject.registerClass(
class QuotaPanelButton extends PanelMenu.Button {
    _init(options = {}) {
        super._init(0.0, 'OpenCodeQuota', false);

        this._snapshot = null;
        this._busy = false;
        this._timeoutId = null;
        this._lastRefresh = 0;
        this._panelBox = options.box ?? 'right';
        this._refreshSeconds = options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
        this._onMove = options.onMove ?? null;
        this._onRefreshSecondsChange = options.onRefreshSecondsChange ?? null;

        this._label = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.add_child(this._panelLabel('Quota …', null));
        this.add_child(this._label);

        this._render();
        this._refresh().catch(() => {});
        this._scheduleRefresh();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                return;
            const age = Math.floor(Date.now() / 1000) - this._lastRefresh;
            if (age > CACHE_TOLERANCE_SECONDS)
                this._refresh().catch(() => {});
        });
    }

    _scheduleRefresh() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshSeconds,
            () => {
                this._refresh().catch(() => {});
                return GLib.SOURCE_CONTINUE;
            });
    }

    _setRefreshSeconds(seconds) {
        if (seconds === this._refreshSeconds)
            return;
        this._refreshSeconds = seconds;
        this._scheduleRefresh();
        this._onRefreshSecondsChange?.(seconds);
        this._render();
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        try {
            // `widget --print --live` performs a real provider refresh for every
            // configured plan and returns their windows without opening a window.
            const result = await runCli(['widget', '--print', '--live']);
            if (result.code !== 0)
                throw new Error(result.stderr.trim() || `widget --print exited with ${result.code}`);

            const payload = JSON.parse(result.stdout);
            if (!Array.isArray(payload.providers) || payload.providers.length === 0)
                throw new Error('No quota data');

            this._snapshot = parseSnapshot(payload);
            this._error = null;
        } catch (e) {
            this._error = e.message ?? String(e);
            // Keep the last successful snapshot so a transient failure (network,
            // provider hiccup) does not blank the panel; the menu shows the error.
        } finally {
            this._busy = false;
            this._lastRefresh = Math.floor(Date.now() / 1000);
            this._render();
        }
    }

    _render() {
        this.menu.removeAll();

        const snapshot = this._snapshot;

        if (!snapshot || snapshot.providers.length === 0) {
            this._setErrorLabel(this._error ? 'Quota !' : 'Quota –');
            const item = new PopupMenu.PopupMenuItem(
                this._error ?? 'No quota data. Is the opencode-quota CLI installed?',
                {reactive: false});
            this.menu.addMenuItem(item);
        } else {
            this._setProvidersLabel(snapshot.providers);

            for (const provider of snapshot.providers) {
                const header = new PopupMenu.PopupMenuItem(provider.name, {reactive: false});
                header.label.add_style_class_name('quota-header');
                this.menu.addMenuItem(header);

                for (const entry of provider.entries) {
                    const value = entry.percent !== null ? `${formatPercent(entry.percent)} left` : (entry.value ?? '—');
                    const reset = entry.resetsIn !== null && entry.resetsIn > 0
                        ? `  ·  resets in ${relativeTime(entry.resetsIn)}`
                        : '';
                    const row = new PopupMenu.PopupMenuItem(`${entry.label}  ${value}${reset}`,
                        {reactive: false});
                    row.label.add_style_class_name('quota-detail');
                    if (entry.percent !== null)
                        row.label.add_style_class_name(severityClass(entry.percent));
                    this.menu.addMenuItem(row);
                }
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }
        }

        const positionItem = new PopupMenu.PopupSubMenuMenuItem('Panel position');
        for (const box of PANEL_BOXES) {
            const item = new PopupMenu.PopupMenuItem(PANEL_BOX_LABELS[box]);
            item.setOrnament(box === this._panelBox
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                this._onMove?.(box);
            });
            positionItem.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(positionItem);

        const intervalItem = new PopupMenu.PopupSubMenuMenuItem('Refresh interval');
        for (const option of REFRESH_OPTIONS) {
            const item = new PopupMenu.PopupMenuItem(option.label);
            item.setOrnament(option.seconds === this._refreshSeconds
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
            item.connect('activate', () => {
                this._setRefreshSeconds(option.seconds);
            });
            intervalItem.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(intervalItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => {
            this._refresh().catch(() => {});
        });
        this.menu.addMenuItem(refreshItem);

        const ageText = snapshot?.exportedAt
            ? `Updated ${new Date(snapshot.exportedAt * 1000).toLocaleTimeString()}`
            : 'No quota data yet';
        const footerText = this._error ? `${ageText} · ${this._error}` : ageText;
        const footer = new PopupMenu.PopupMenuItem(footerText, {reactive: false});
        footer.label.add_style_class_name('quota-detail');
        if (this._error)
            footer.label.add_style_class_name('quota-critical');
        this.menu.addMenuItem(footer);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _panelLabel(text, severity) {
        const label = new St.Label({
            text,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'quota-panel-label',
        });
        if (severity)
            label.add_style_class_name(severity);
        return label;
    }

    _clearLabel() {
        this._label.destroy_all_children();
    }

    _setErrorLabel(text) {
        this._clearLabel();
        this._label.add_child(this._panelLabel(text, 'quota-critical'));
    }

    _setProvidersLabel(providers) {
        this._clearLabel();
        for (const provider of providers) {
            const name = this._panelLabel(
                provider.name,
                severityClass(provider.lowest?.percent ?? 100));
            name.add_style_class_name('quota-provider-name');
            this._label.add_child(name);
            for (const entry of provider.entries) {
                if (entry.percent === null)
                    continue;
                this._label.add_child(this._panelLabel(
                    `${shortWindowLabel(entry.label)} ${formatPercent(entry.percent)}`,
                    severityClass(entry.percent)));
            }
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        super.destroy();
    }
});

export default class OpenCodeQuotaExtension extends Extension {
    enable() {
        this._state = loadPanelState();
        this._buildButton();
    }

    _buildButton() {
        this._button = new QuotaPanelButton({
            box: this._state.box,
            refreshSeconds: this._state.refreshSeconds,
            onMove: box => this._moveTo(box),
            onRefreshSecondsChange: seconds => {
                this._state.refreshSeconds = seconds;
                savePanelState(this._state);
            },
        });
        Main.panel.addToStatusArea('opencode-quota', this._button, 0, this._state.box);
    }

    _moveTo(box) {
        if (box === this._state.box)
            return;
        this._state.box = box;
        savePanelState(this._state);
        this._button?.destroy();
        delete Main.panel.statusArea['opencode-quota'];
        this._buildButton();
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
