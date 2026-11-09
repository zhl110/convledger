#!/bin/sh
# 起 hub（若没跑）并打开会话库；macOS / Linux 用。Windows 用 open-map.vbs 或开始菜单快捷方式。
exec node "$(dirname "$0")/tool/bin/convledger.mjs" map --open "$@"
