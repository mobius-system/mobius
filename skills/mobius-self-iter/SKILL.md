---
name: mobius-self-iter
description: What to do after self iter
---

【通过自迭代修复或者提升Mobius系统自身的能力】
- 你需要找到系统中的一个自迭代项目（bind_path = APP_DIR）
- 在该项目中提交Issue，然后创建Session，

每次修改mobius代码，先commit所有文件（包括那些不是你亲自修改的文件），然后执行 python3 start.py 以更新代码

python3 start.py 会调用 pm2 无缝编译新代码和重新部署

commit 时，commit message需要是“中文代码变动说明 (英文代码变动说明)”，commit message 不允许包含人名，确保 git commit 的邮箱是 mobius_os@163.com
