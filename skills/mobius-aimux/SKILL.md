---
name: mobius-aimux
description: Operate a remote machine (Windows, Linux, Mac) that a user has reverse-connected into the mobius.
---


# 一：反向设备连接（bridge 连接）

在莫比乌斯系统中，任何设备都可以通过 aimux 反向连接到系统中，让智能体有能力协助用户操作远程设备。

## 检查你自己是否有可用的 aimux

`aimux -h`

>
> 补充知识：安装方法很简单 `pip install aimux` 即可，这个依赖很轻。
>

## 获取可用设备清单

`aimux remote ls | grep bridge`

>
> 补充知识：你可以使用 `aimux remote ls | grep ssh` 获取可以通过正向 ssh 连接的设备。
> 也可以使用 `aimux remote ls --json` 获取 json 格式的输出。
>

反向设备的**核心特征**是它带有 `profiles`（连接配置），创建会话时必须选定一个。反向设备的行大致长这样（注意 TYPE=bridge、PORT=-、PROFILES 列是个名字）：

```
HOST           TYPE    USER/PLATFORM  HOSTNAME/PROFILES  PORT   STATUS      RTT
<device_name>  bridge  linux          posix-pty          -      connected   -
```
>
> 记下 `profiles`（本例 `posix-pty`），下一步 `--profile` 就取它。多数情况直接用 `default_profile` 即可。
>

## 状态判读

| STATUS | 能否使用 |
|--------|---------|
| `connected` | ✅ 设备已反向连回，可直接用 |
| `auth-required` | ❌ 设备未上线或认证未通，需等待设备重连 / 排查 bridge |


## 创建会话（反向设备的关键步骤，即在目标设备上打开一个终端）

```bash
aimux new --remote <device_name> --profile posix-pty --name <session-name>
```

常用选项：

```
aimux new [OPTIONS]
  *  --name                会话名（必填）
     --remote              反向设备名（如 <device_name>）
     --profile             profile 名（反向设备必填，如 posix-pty / cmd 等，不同操作系统不一样）   ← 核心
     --cwd                 初始工作目录
     --cmd                 初始执行的命令
     --output-sync-to-file 实时镜像 pane 输出到文件
     --reuse               会话已存在则直接返回成功（避免重复创建报错）
```

变体示例：

```bash
# 指定初始目录
aimux new --remote <device_name> --profile posix-pty --name ros --cwd /home/jetson/catkin_ws

# 安全复用
aimux new --remote <device_name> --profile posix-pty --name embedded-test --reuse
```


## 操作会话（send-keys + capture，即在刚才打开的终端中输入命令，然后查看输出）

反向设备的会话标识为 `<设备名>/<会话名>`。
用 `send-keys` + `capture`，**不要用 `attach`**（那是给人交互用的）。

## 发送命令

```bash
# 末尾 Enter 表示回车提交
aimux send-keys "<device_name>/<session-name>" -- 'uname -a' Enter

# 一次发多行
aimux send-keys "<device_name>/<session-name>" -- 'cd /tmp' Enter 'ls -la' Enter
```

## 捕获输出

```bash
aimux capture "<device_name>/<session-name>" --lines 30
```

输出通常带 ANSI 颜色/光标码，需要干净文本就过滤：

```bash
aimux capture "<device_name>/<session-name>" --lines 40 \
  | sed 's/\x1b\[[0-9;]*[mGKHJ]//g; s/\x1b\][0-9];[^\x07]*\x07//g'
```

## 等待执行

反向设备经 bridge 中转，命令执行有延迟。发送后 `sleep N` 再 capture。
> ⚠️ `aimux wait-last-command-complete` **仅本地会话支持，反向 bridge 会话不可用**。


## 文件传输

反向设备同样走 sftp 通道，只是把「远程地址」换成设备名即可：

```bash
# 上传：本地 → 设备
aimux send_files <device_name> /home/jetson/upload ./run.py ./data.csv
#   （加 --gitignore 可跳过被忽略的文件）

# 下载：设备 → 本地
aimux get_files <device_name> ./downloads /home/jetson/logs/
```

## 销毁会话

```bash
aimux kill "<device_name>/<session-name>"
```

> ⚠️ `kill` 不支持通配符/批量，需逐个销毁。


## 常见问题

| 现象 | 原因 / 解决 |
|------|-------------|
| `--profile is required for bridge remote` | 反向设备未带 `--profile`。先 `aimux remote ls --json` 查 profile 名 |
| 设备状态 `auth-required` / 时连时断 | 设备未稳定反向连回 bridge；等设备重连或排查设备端 bridge 客户端 |
| 创建会话后 capture 无输出 | 命令仍在执行，加大 `sleep` 再 capture；确认 profile 的 `available=true` |
| `wait-last-command-complete` 报错 | 该命令仅本地会话支持，反向 bridge 不可用 → 改用 `sleep` + `capture` |
| `new` 报会话已存在 | 加 `--reuse` |
| capture 输出乱码 | ANSI 码，用第 4.2 节 `sed` 过滤 |


## 速查表

```bash
aimux remote ls [--json]                                 # 识别反向设备 + 拿 profile
aimux new --remote <dev> --profile <p> --name <sess>     # 创建反向会话（必带 --profile）
aimux ls                                                 # 列出会话
aimux send-keys "<dev>/<sess>" -- '<cmd>' Enter          # 发命令
aimux capture "<dev>/<sess>" --lines N                   # 取输出
aimux send_files <dev> <remote_dir> <local>...           # 上传
aimux get_files  <dev> <local_dir>  <remote>...          # 下载
aimux kill "<dev>/<sess>"                                # 销毁
```

## 销毁会话

任务完成后，记得通过 `aimux kill "<dev>/<sess>"` 销毁会话。

## Windows中操作终端的常见错误

记得powershell，cmd，mingw64的命令是有区别的！





## 端到端实战（连接 Jetson 设备）

```bash
# 0. PATH（首次）
export PATH="/root/.local/bin:$PATH"

# 1. 确认是反向设备 + 拿到 profile 名
aimux remote ls --json        # → type=bridge, default_profile=posix-pty

# 2. 创建会话（带 --profile）
aimux new --remote <device_name> --profile posix-pty --name <session-name>

# 3. 发命令取设备信息
aimux send-keys "<device_name>/<session-name>" -- 'uname -a; hostname; df -h /' Enter
sleep 2
aimux capture "<device_name>/<session-name>" --lines 40

# 4. 上传脚本
aimux send_files <device_name> /home/jetson/scripts ./run.py

# 5. 用完销毁
aimux kill "<device_name>/<session-name>"
```
