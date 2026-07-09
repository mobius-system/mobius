# Web Terminal: Run Commands Anytime Inside a Session

‍

> In any session (an Issue's Session or a Research Agent), you can pop up a web terminal in two clicks — no need to switch to an external SSH client — and run commands directly on the server: check logs, run scripts, start services, or edit configs with vim.

## ① Open the "…" menu and choose "Web Terminal"

Click the "**…**" button in the session header, then choose "**Web Terminal**" from the menu — it sits just below the "Show / hide time & index" item.

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_01.jpg)

## ② Terminal connected — start typing

Once the popup opens, a green "**Connected**" label appears at the top. Below it is a real shell whose working directory defaults to the current project's folder. Just type your commands.

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_02.jpg)

## ③ Commands run live on the server

Type a command and press Enter — the output streams back in real time, exactly like a local terminal. It's a full PTY, so vim, top, arrow keys, and Tab completion all work.

![image](https://serve.nutshellai.cn/publish/auto/tutorial/26_web_terminal_03.jpg)

‍

> Tip: The terminal opens in the current project directory by default. Pressing **Esc does NOT close the popup** (Esc is reserved for programs like vim) — click the ✕ at the top-right or click the backdrop to close. Closing the popup reclaims the process; nothing is left running on the server.
