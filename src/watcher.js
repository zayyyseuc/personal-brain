const chokidar = require('chokidar');
const path = require('path');
const { indexFile, ensureIndex } = require('./indexer');
require('dotenv').config();

function startWatcher() {
  ensureIndex().then(() => {
    const watcher = chokidar.watch(process.env.VAULT_PATH, {
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
      persistent: true,
      ignoreInitial: true,
    });

    watcher
      .on('add', filePath => {
        if (filePath.endsWith('.md')) {
          console.log(`新文件: ${path.relative(process.env.VAULT_PATH, filePath)}`);
          indexFile(filePath).catch(console.error);
        }
      })
      .on('change', filePath => {
        if (filePath.endsWith('.md')) {
          console.log(`文件更新: ${path.relative(process.env.VAULT_PATH, filePath)}`);
          indexFile(filePath).catch(console.error);
        }
      });

    console.log('文件监听已启动，vault 变动将自动更新索引');
  });
}

module.exports = { startWatcher };