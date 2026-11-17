# 从 pi-telegram-operator 迁移到 pi-Ops

建议先在实机验证消息链路，再启用后台服务。现阶段本项目已通过本地和模拟 TG 测试，尚未完成真人 Telegram 账号联调；请保留旧配置以便回退。

## 迁移边界

- 可以复用原 Bot Token 和 Telegram 私聊，保留 BotFather 的 Threaded Mode。
- 同一个 Bot 必须只由一个 operator 长轮询。**关闭旧 Pi 进程并停用旧后台服务，再启动新项目。** 两个项目端口不同，并不能避免 TG 长轮询冲突。
- Pi 的 auth.json、models.json、settings.json 中其他配置和 sessions/ 会话历史不需要删除或重建。
- 旧 operator 的 secret/config/state 文件不会自动导入。pi-Ops 重新验证绑定用户，并把新状态保存在独立的 pi-ops/ 目录。
- 旧 Topic、消息、状态卡仍在 TG 中，但其映射和按钮不会自动转移。第一次迁移建议使用新 Topic。旧状态 JSON 不能覆盖 pi-Ops 的 schedule.db。
- 首次实机建议使用已验证的 Pi 1.5.2，或兼容的较新版本；Node 必须 >=22.19。安装依赖和运行脚本的 Node/Bun 必须能在该机器架构上运行。

以下命令用于 macOS/Linux，包括运行 Linux 的 Raspberry Pi。目录需要按你的实际安装调整。

## 1. 关闭旧 Pi，卸载旧服务并备份

先退出所有加载了旧 operator 的 Pi 会话。保留终端，设置路径：

```bash
pi_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
old_operator_dir="$pi_agent_dir/git/github.com/JohnsonRan/pi-telegram-operator"
```

如果旧项目装过系统服务，先卸载；**不要先 pi remove，否则 service.cjs 可能已被删除**：

```bash
node "$old_operator_dir/service.cjs" uninstall
```

如果提示文件不存在，使用你原来克隆的 operator 目录。如果从未安装服务，跳过这一命令。可在 Linux 用 `systemctl --user status pi-telegram-operator` 检查；macOS 旧服务标签是 `com.johnsonran.pi-telegram-operator`。

备份旧配置和状态，包含 Bot Token 的备份仅允许当前用户访问：

```bash
pi_ops_backup="$pi_agent_dir/pi-telegram-operator-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$pi_ops_backup"
for pi_ops_old_file in pi-telegram-operator.secret pi-telegram-operator.json pi-telegram-operator.state.json; do
  if [ -f "$pi_agent_dir/$pi_ops_old_file" ]; then
    cp -p "$pi_agent_dir/$pi_ops_old_file" "$pi_ops_backup/"
    chmod 600 "$pi_ops_backup/$pi_ops_old_file"
  fi
done
```

查看实际注册的包来源，再移除旧包：

```bash
pi list
pi remove git:github.com/JohnsonRan/pi-telegram-operator
```

如果 `pi list` 中来源带版本号或使用其他格式，请把 `pi remove` 的参数替换成列表里的实际来源。若当初通过 `~/.pi/agent/extensions/` 软链接加载，也要移除那条旧软链接；只处理确认属于旧 operator 的链接，保留源码及备份。

## 2. 克隆新项目，安装依赖并加载扩展

先确认环境：

```bash
node --version
pi --version
bun --version
```

示例使用 SSH 地址，实机需要已配置可访问该仓库的 GitHub SSH key：

```bash
mkdir -p "$HOME/code"
git clone git@github.com:YoisakiKnd/pi-Ops.git "$HOME/code/pi-Ops"
cd "$HOME/code/pi-Ops"
bun install --frozen-lockfile --ignore-scripts
pi install "$PWD"
```

仓库公开且实机未配置 SSH 时，可以把 clone URL 换成 `https://github.com/YoisakiKnd/pi-Ops.git`。本地目录必须长期保留；扩展、后台 worker 和服务脚本都从这里加载。

不要只复制 index.ts。src/ 和安装好的依赖也必须存在。Pi 对本地包不自动安装依赖；后台 worker 在独立 Node 进程中直接导入 Pi SDK。

没有 Bun 时，可用 `npm install --ignore-scripts` 安装依赖再运行 `pi install "$PWD"`，但 npm 不读取 bun.lock，会根据 package.json 重新解析版本。首次实机测试优先使用 Bun 锁定版本。

可先运行：

```bash
bun run check
```

测试使用临时目录、模拟 TG API 和本机监听端口，不会给真实 Bot 发消息，也不会安装真实系统服务。

## 3. 重新绑定同一个 Bot

确保旧 operator 已停止。若此前启动过 pi-Ops broker，也先执行 `bun run ops stop`。随后在新仓库目录运行：

```bash
node setup.cjs
```

脚本会：

1. 隐藏输入 Bot Token。可从原来的 secret 文件自行取出，在本机输入；不要发到聊天或写进 Git。
2. 要求向 Bot 私聊发送本次生成的 `/start <code>`，确认绑定你的 TG 账号。
3. 创建并删除测试 Topic，检查 Threaded Mode。
4. 询问允许离线唤醒的项目目录，例如 `/home/pi/code`。留空会禁用离线唤醒；填写后 `/new`、`/clone` 也受此目录限制。

新状态位于 `$PI_CODING_AGENT_DIR/pi-ops/`，默认 `~/.pi/agent/pi-ops/`：

- config.json：配置、绑定账号、允许目录。
- telegram.secret：独立保存的 Token，0600 权限。
- schedule.db：任务、运行历史、TG Topic、消息和问答队列，**需要备份，不能当缓存删除**。
- memory/：可手工编辑的 Markdown 记忆。

旧 operator 的文件继续保留，不会被这个流程覆盖。

## 4. 实机冒烟验证

进入一个允许的项目目录，启动 Pi，并确认现有模型登录仍正常：

```bash
cd /你的项目目录
pi
```

给 Pi 发一个普通问题。首次输出应创建一个新 Topic 和状态卡。按顺序检查：

- 在 Topic 发消息，Pi 收到；忙时消息以 steer 形式进入当前任务。
- Pi 回复回到同一个 Topic；另开项目会话，应使用另一个 Topic。
- Stop 按钮或 `/stop` 能中断任务。
- 上传小文本文件，Pi 能读取；请求 Pi 通过 telegram_send_file 发回项目内文件。
- 请求 Pi 调用 telegram_ask_user_question，检查单选与多选 Done。
- 在本地运行 `/ops tg status` 和 `/ops status`，检查错误和连接状态。
- 开启离线唤醒后退出 Pi，在原 Topic 发消息，确认恢复原会话；在 Bot 主聊天中试 `/new /允许目录/项目 | 列出文件`。

后台和离线会话继承 Pi 自身的工具、扩展、MCP、模型与配置，插件不再默认设置只读白名单、轮数上限或执行截止。只有你明确指定的任务工具/执行限制才会覆盖 Pi 默认行为。

如需复用旧 Topic，可在新会话已注册后，用 `/ops tg status` 找到 session ID，再执行 `/ops tg bind <session-id> <旧-topic-id>`。只有确认 ID 对应同一会话时才这样做；旧 operator 的按钮和状态卡仍不会迁移。

## 5. 验证正常后安装后台服务

从固定的新仓库目录执行：

```bash
cd "$HOME/code/pi-Ops"
node service.cjs install --dry-run
node service.cjs install
node service.cjs status
```

Linux 用 systemd 用户服务 `pi-ops.service`；macOS 用 `dev.pi-ops.agent` LaunchAgent。脚本不使用 sudo，不改系统级服务。Linux 要在未登录时也运行，需要另行配置用户 lingering；先在当前用户登录状态下完成验证。

移动仓库、更新服务配置或代理环境后，应重新安装/重启服务。日常更新：

```bash
cd "$HOME/code/pi-Ops"
git pull --ff-only
bun install --frozen-lockfile --ignore-scripts
node service.cjs restart
```

之后重启交互 Pi 会话，确保加载的是同一版本。Windows 服务安装尚未支持。

## 回退到旧 operator

1. 关闭加载 pi-Ops 的所有 Pi 会话。
2. 若已安装新服务，执行新仓库中的 `node service.cjs uninstall`；只运行 broker 时执行 `bun run ops stop`。
3. `pi list` 确认本地包来源，再 `pi remove "$HOME/code/pi-Ops"`，并移除任何手工创建的新软链接。
4. 原 operator 的 secret/config/state 正常情况下仍在原位置；如丢失，从上面的私有备份还原，权限设为 0600。
5. `pi install git:github.com/JohnsonRan/pi-telegram-operator`，再从其实际安装目录运行 `node service.cjs install`（如果之前使用后台服务）。
6. 重启 Pi。整个过程始终只让一个项目使用原 Bot 轮询。

回退不用删除 pi-Ops 的 schedule.db 或 memory/，留作后续排查和恢复。旧 Topic 及 Pi 的原会话文件也不需要删除。
