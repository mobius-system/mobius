# 网页终端：在会话里随时开终端跑命令

‍

> 在任意会话（Issue 的 Session 或 Research 的 Agent）里，不用切到外部 SSH，点两下就能弹出一个网页终端，直接在服务器上敲命令——查日志、跑脚本、起服务、用 vim 改配置都行。

## ① 打开「…」菜单，选「Web 终端」

在会话头部点右上角的「**…**」按钮，在弹出的菜单里（「显示时间与序号」这一项的**下方**）选择「**Web 终端**」。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_01.jpg)

## ② 终端已连接，直接敲命令

弹窗打开后，顶部会显示绿色「**已连接**」，下方就是一个真实的 shell。它的工作目录默认就是当前项目目录，直接敲命令即可。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_02.jpg)

## ③ 命令在服务器上实时执行

输入命令回车，输出实时回显——和本地终端一模一样。它是一个完整的伪终端（PTY），vim、top、方向键、Tab 补全等交互都正常工作。

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_03.jpg)

‍

> 小贴士：终端默认开在当前项目目录；按 **Esc 不会关闭弹窗**（Esc 留给 vim 等程序用），点右上角的 ✕ 或点弹窗外的遮罩即可关闭；关闭即释放，不会在服务器留下后台进程。
