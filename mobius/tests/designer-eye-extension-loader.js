const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDesignerEyeLoaderInjection } = require('../backend/services/designer-eye-loader');

const injection = buildDesignerEyeLoaderInjection();

assert(
  !/type=["']module["']/i.test(injection),
  '拓展页注入不得在页面 import map 前触发模块脚本加载',
);
assert(
  /<script\s+defer\s+src=["']\/designer-eye\/loader\.js["']><\/script>/i.test(injection),
  '拓展页应注入延迟执行的经典 Designer Eye 加载器',
);

const loaderPath = path.join(__dirname, '../frontend/public/designer-eye/loader.js');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');

assert(
  loaderSource.includes("import('./index.js')"),
  'Designer Eye 加载器应通过相对 URL 动态导入现有入口模块',
);
assert(
  loaderSource.includes('.catch('),
  'Designer Eye 加载失败不得产生未处理的 Promise rejection',
);

console.log('designer-eye extension loader tests passed');
