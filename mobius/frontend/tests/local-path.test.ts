import assert from 'node:assert/strict'
import { localFolderName } from '../src/services/local-path'

assert.equal(localFolderName('D:\\work\\pawbench'), 'pawbench')
assert.equal(localFolderName('D:\\work\\pawbench\\'), 'pawbench')
assert.equal(localFolderName('/home/example/pawbench'), 'pawbench')
assert.equal(localFolderName('/home/example/pawbench/'), 'pawbench')
assert.equal(localFolderName('  C:\\项目\\磁盘分析  '), '磁盘分析')
assert.equal(localFolderName(''), '')

console.log('local path tests passed')
