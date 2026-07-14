# 切换工作区布局

‍

在 Issue / Research 页，你可以用顶栏的「切换工作区布局」按钮，在三种工作区形态之间切换——纯对话、VSCode 编辑、或原生文件编辑器。布局偏好保存在你的浏览器里，下次进来还是上次的布局。

## 1. 找到顶栏的布局按钮

- 进入任意 Issue 或 Research 页（需已选中一个 Session），点顶栏的 **「切换工作区布局」** 图标。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut29-button.jpg)

## 2. 选择一种布局

- 弹出三种模式：

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut29-dropdown.jpg)

| 模式 | 说明 | 可用条件 |
| --- | --- | --- |
| **高效会话模式** | 左 Issue/Session 侧栏 + 右对话区，专注操控智能体 | 始终可用 |
| **VSCode 编辑** | 左内置 VSCode 编辑器 + 右对话，边改代码边对话 | 项目需绑定路径 + 配置 Web 编辑器 (`VSCODE_WEB_URL`) |
| **原生文件编辑器** | 左文件浏览 + 中代码预览 + 右对话（不依赖 code-server） | 项目需绑定路径 |

> 某个选项**置灰不可选**时，把鼠标悬上去会看到原因（如「项目未绑定路径」「未配置 Web 编辑器」）。

## 3. 切到「原生文件编辑器」后

- 左侧是原生文件浏览器，中间浏览/编辑代码，右边继续对话——适合不想开 code-server、又要看代码改代码的场景。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/tut29-native-editor.jpg)

!!! tip
    - 布局是**全局偏好**（按浏览器保存），切到任意 Issue / Research 页都会沿用。
    - 个别纯 Git 类 Issue（全是 agent 跑 git 命令）会被**精确隐藏**布局入口，避免无意义的「左代码右对话」。
    - 移动端、用户主页、项目主页不显示布局切换（代码对话为桌面端能力）。
