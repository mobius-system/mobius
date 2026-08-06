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
  /<script\s+defer\s+src=["']\/extension\/_sdk\/designer-eye\/loader\.js["']><\/script>/i.test(injection),
  '拓展页应从稳定的 extension SDK 路由注入延迟经典加载器',
);

const loaderPath = path.join(__dirname, '../frontend/public/designer-eye/loader.js');
const loaderSource = fs.readFileSync(loaderPath, 'utf8');

assert(
  /import\(['"]\.\/index\.js\?v=[^'"]+['"]\)/.test(loaderSource),
  'Designer Eye 加载器应通过带版本的相对 URL 动态导入现有入口模块',
);
assert(
  loaderSource.includes('.catch('),
  'Designer Eye 加载失败不得产生未处理的 Promise rejection',
);

const mainHtml = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
assert(
  /<script\s+defer\s+src=["']\/extension\/_sdk\/designer-eye\/loader\.js["']><\/script>/i.test(mainHtml),
  'Mobius 主前端也应使用稳定的 extension SDK 经典延迟加载器',
);
assert(
  !/type=["']module["'][^>]+designer-eye/i.test(mainHtml),
  'Mobius 主前端不得让 Vite 直接解析 Designer Eye SDK 模块地址',
);

console.log('designer-eye extension loader tests passed');
