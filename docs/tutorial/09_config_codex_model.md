# 如何配置 Codex + 模型

‍

Codex（命令行代码模型）在「**管理中心 → 模型接入 → Codex**」里配置。每个「渠道」对应一份 `~/.codex/<渠道>.config.toml`，会话启动时用 `codex --profile <渠道>` 指定。

## 1. 进入模型接入 → Codex

- 打开右上角头像菜单 → **管理中心** → 顶部切到「**模型接入**」标签 → 右上角选 **Codex**。左侧是已导入渠道，右侧是新增 / 编辑表单。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/adm-codex-overview.jpg)

## 2. 新增一个 Codex 渠道

- 点「**新增**」，按下表填写（**只会保存、不会立即测试**，放心填）：

![image](https://serve.nutshellai.cn/publish/auto/tutorial/adm-codex-form.jpg)

| 字段 | 说明 |
| --- | --- |
| ① 渠道（纯英文字母） | 渠道名，同时是 `--profile` 标识和 config 文件名，如 `mychannel` |
| ② 显示名称 | 在模型选择菜单里展示的名字，如 `我的 Codex` |
| ③ Codex 模型名 (-m) | 传给 codex 的 `-m` 参数，如 `gpt-5.5` |
| ④ 秘钥名 (env_key) | api_key 要导出到的环境变量名，默认 `RIGHTCODE_API_KEY` |
| ⑤ 秘钥值 | 真实 API Key（`sk-...`），编辑已有渠道时留空表示不改 |
| ⑥ config TOML | 自动生成，写到 `~/.codex/<渠道>.config.toml`，含 `base_url` / `api_key` 等 |

- 填好点「**保存**」。

## 3. 用起来

- 保存后系统会写入 `~/.codex/<渠道>.config.toml`，并把秘钥导出到你填的 `env_key`。
- 之后**新建会话 / 研究任务**时，模型选择菜单里就能看到这个渠道；列表里 `启用 / config 已写入 / 秘钥已设置` 三个标记都为绿即代表就绪。
