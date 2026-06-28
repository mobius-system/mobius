# 如何配置 Claude Code + 模型

‍

Claude Code 模型在「**管理中心 → 模型接入 → Claude Code**」里配置。每个模型走 `--settings <文件>` 直连上游（不走代理），适合接入 OpenAI 兼容 / Claude / 国产大模型。

## 1. 进入模型接入 → Claude Code

- 右上角头像菜单 → **管理中心** →「**模型接入**」标签 → 右上角选 **Claude Code**。左侧是已导入模型，右侧是新增 / 编辑表单。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/adm-cc-overview.jpg)

## 2. 新增一个 Claude Code 模型

- 点「**新增**」，按下表填写：

![image](https://serve.nutshellai.cn/publish/auto/tutorial/adm-cc-form.jpg)

| 字段 | 说明 |
| --- | --- |
| ① 模型 Key | 唯一标识（自动生成长 key 也可，自定义短名也可） |
| ② 显示名称 | 模型选择菜单里展示的名字，如 `我的 Claude 模型` |
| ③ Claude 模型名 | 真实模型 ID，如 `claude-sonnet-4-6`、`glm-4.7` |
| ④ settings JSON | 写入 settings 文件的 JSON，含 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 等 |
| ⑤ 启用 + 保存 | 勾选「启用」后点「保存」 |

- **settings JSON 示例**（接 OpenAI 兼容接口）：

  ```json
  {
    "env": {
      "ANTHROPIC_BASE_URL": "https://你的接口/v1",
      "ANTHROPIC_AUTH_TOKEN": "sk-你的key",
      "ANTHROPIC_MODEL": "claude-sonnet-4-6"
    }
  }
  ```

## 3. 用起来

- 保存后生成对应的 `settings` 文件；新建会话时在模型选择菜单里就能看到并选用。
- 想临时停用某个模型：在列表里点开它，取消「启用」再保存即可（已建会话不受影响）。
