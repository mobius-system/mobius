const assert = require('assert');
const fs = require('fs');
const path = require('path');

const expenseHtml = fs.readFileSync(path.join(__dirname, '../extension/expense/frontend/index.html'), 'utf8');
const expenseJs = fs.readFileSync(path.join(__dirname, '../extension/expense/frontend/main.js'), 'utf8');
const loginPage = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Login.tsx'), 'utf8');

assert(expenseHtml.includes('id="authBanner"'), 'expense page should include an auth banner');
assert(expenseHtml.includes('id="loginBtn"'), 'expense page should include a login button');
assert(expenseJs.includes('function loginHref()'), 'expense frontend should build a return-aware login URL');
assert(expenseJs.includes('showLoginRequired'), 'expense frontend should show login-required UI');
assert(expenseJs.includes('请先登录后再上传图片'), 'expense upload should explain login is required');
assert(loginPage.includes('readSafeNextPath'), 'login page should validate next redirect paths');
assert(loginPage.includes('window.location.assign(nextPath)'), 'login page should return to next path after login');

console.log('expense-mobile-login-entry tests passed');
