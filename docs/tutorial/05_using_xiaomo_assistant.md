# 如何使用【小莫助手 Web 端】

‍

小莫是莫比乌斯里的轻量随身助手，悬浮在**每个页面的右下角**。点开就能提问、追问、派分身、传文件、用语音——不用先建项目或任务。本篇带你走完一遍。

## 1. 打开小莫

- 每个页面右下角都有一个「小莫」圆钮，**点它**即可打开助手面板。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-01-entry.jpg)

## 2. 面板长这样

- 打开后是一个浮层：**左侧是会话列表**（主体小莫 + 分身小莫），中间是对话记录，下方是**输入框**。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-02-panel.jpg)

## 3. 提问，然后等小莫回答

- 在输入框写下问题，**回车**或点「发送」。第一次提问会自动为你创建一个「我的主小莫」会话，之后的追问都沿用它（上下文不会丢）。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-03-input.jpg)

- 小莫的回复支持 Markdown——**代码、列表、表格都会渲染**。回复较长时，点顶部「放大查看」可切到更大 / 全屏视图（下图即为放大后的效果）。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-04-reply.jpg)

## 4. 顶部工具栏

- 面板顶部一排小按钮，常用的几个：

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-05-toolbar.jpg)

- **新窗口打开**：把当前会话开成独立网页，方便长开。
- **查看技能**：在 VSCode 里查看 / 编辑小莫用到的技能（Skill）。
- **预设配置**：预先定义一个小莫会话模板，方便复用（见第 7 节）。
- **放大 / 全屏**：紧凑 → 放大 → 全屏，三档循环。
- **关闭**：收起面板（对话不会被清空）。

## 5. 开一个「分身小莫」并行跑任务

- 想让小莫**同时干另一件事**、又不打断当前对话？点「开分身」，写清这个分身要**单独**完成的任务、选模型，创建即启动。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-06-clone.jpg)

- 分身只处理这一件事，完成后会把结果**回传给主体小莫**统一收尾。左侧会话列表里会多出一个「分身小莫 #N」。

## 6. 语音 & 附件

- 输入框右侧一排小按钮：

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-08-voice.jpg)

- **上传图片 / 文件**：点按钮选择，或直接**粘贴截图、拖拽文件**进输入框。
- **语音输入**：点一下说话，自动转成文字发出去。
- **展开大输入框**：要写长内容时展开。
- 顶部还有「**开启回复语音播报**」开关——打开后小莫会把每条回复读出来（可切换音色）。

## 7. 预设（进阶，可跳过）

- 点「预设配置」可预先定义一个小莫会话模板：先填**会话名称**和**目的 / 要解决的问题**，下一步再选模型与技能。保存后下次可直接套用，省去重复描述。

![image](https://serve.gptacademic.cn/publish/auto/tutorial/xm05-07-preset.jpg)

‍

> 一句话总结：小莫是你随叫随到的副手——**随时点开、随时提问，需要并行就派分身**。
