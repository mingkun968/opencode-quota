#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DATA_DIR=${XDG_DATA_HOME:-"$HOME/.local/share"}
CONFIG_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}
BIN_DIR="$HOME/.local/bin"
EXTENSION_DIR="$DATA_DIR/gnome-shell/extensions/opencode-quota@local"
BACKUP_DIR="$DATA_DIR/pi-quota/backups/$(date +%Y%m%d-%H%M%S)-$$"

command -v python3 >/dev/null 2>&1 || {
    echo '需要 Python 3。' >&2
    exit 1
}
test -f "$SOURCE_DIR/pi-quota.py"
test -f "$SOURCE_DIR/gnome/extension.js"

mkdir -p "$BACKUP_DIR" "$BIN_DIR" "$EXTENSION_DIR" "$CONFIG_DIR/pi-quota"
for name in pi-quota opencode-quota; do
    if [ -e "$BIN_DIR/$name" ] || [ -L "$BIN_DIR/$name" ]; then
        cp -P "$BIN_DIR/$name" "$BACKUP_DIR/$name"
    fi
done
for name in extension.js stylesheet.css metadata.json; do
    if [ -f "$EXTENSION_DIR/$name" ]; then
        cp "$EXTENSION_DIR/$name" "$BACKUP_DIR/$name"
    fi
done

if [ ! -e "$CONFIG_DIR/pi-quota/panel.json" ] && [ -f "$CONFIG_DIR/opencode-quota/panel.json" ]; then
    cp "$CONFIG_DIR/opencode-quota/panel.json" "$CONFIG_DIR/pi-quota/panel.json"
fi

install -m 755 "$SOURCE_DIR/pi-quota.py" "$BIN_DIR/pi-quota"
for name in extension.js stylesheet.css metadata.json; do
    install -m 644 "$SOURCE_DIR/gnome/$name" "$EXTENSION_DIR/$name"
done

# The running GNOME session can keep its already-loaded extension code. Its
# existing command now delegates to Pi, so no logout or shell restart is needed.
COMPAT_FILE=$(mktemp "$BIN_DIR/.pi-quota-compat.XXXXXX")
trap 'rm -f "$COMPAT_FILE"' EXIT HUP INT TERM
cat > "$COMPAT_FILE" <<'SH'
#!/bin/sh
exec "$HOME/.local/bin/pi-quota" "$@"
SH
chmod 755 "$COMPAT_FILE"
mv -f "$COMPAT_FILE" "$BIN_DIR/opencode-quota"

echo '已安装 pi-quota。当前顶部栏会在下一次刷新时使用 Pi。'
echo '扩展名称会在下次登录后更新为 Pi Quota，不影响本次额度查询。'
printf '原状态栏文件备份：%s\n' "$BACKUP_DIR"
