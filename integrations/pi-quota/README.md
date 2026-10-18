# Pi Quota

为 GNOME 顶部栏提供 Go 套餐额度，直接读取 Pi 保存的登录信息。只需要 Python 3 和已有的 GNOME 扩展，不需要安装、启动或登录 OpenCode 软件，也不需要构建本仓库的 npm 包。

```sh
sh integrations/pi-quota/install.sh
~/.local/bin/pi-quota show
~/.local/bin/pi-quota show --json
```

当前支持 Pi 的 `opencode-go` API key，查询服务端的 5 小时、周、月额度。百分比表示**剩余**额度。Go 是当前使用的服务商套餐，Pi 是使用该套餐的客户端。

认证默认来自 `~/.pi/agent/auth.json`。可通过 `PI_CODING_AGENT_DIR` 指定其他 Pi agent 目录。使用 Pi 的 `api_key` 条目，支持 `$NAME`、`${NAME}` 和条目 `env` 字段；未保存密钥时可使用 `OPENCODE_API_KEY`。后台查询不执行 `!` 开头的密钥命令。不会读取 OpenCode 的配置或认证文件，不会写入、复制或显示密钥。

安装会复制独立命令到 `~/.local/bin/pi-quota`，并更新已有的顶部栏扩展。位置和刷新间隔会保留；默认 30 秒刷新。为让当前 GNOME 会话在下一次刷新时生效，保留了旧命令名作为指向 `pi-quota` 的兼容入口，扩展 UUID 也沿用原值。它们不依赖 OpenCode 软件。下次登录后，扩展名称显示为 **Pi Quota**；当前 GNOME 50 不支持运行中重载扩展，但旧代码可直接调用兼容入口。

安装前的命令和扩展文件备份到 `~/.local/share/pi-quota/backups/`；安装器不会更改 Pi 认证、卸载 OpenCode 软件或取消 Go 套餐。遇到认证失败、网络错误或无效接口数据时会报告错误，顶部保留上次成功的数据，并在菜单显示错误和更新时间。

```sh
python3 -m unittest discover -s integrations/pi-quota -p 'test_*.py'
```
