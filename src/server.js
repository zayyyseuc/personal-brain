const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { askStream }                        = require('./searcher');
const { indexAll }                         = require('./indexer');
const { startWatcher }                     = require('./watcher');
const { createIdea, listReminders, updateReminder, appendDiscussion } = require('./lab');
const { getReview }                        = require('./reviewer');
const { save: saveConv, list: listConvs, get: getConv } = require('./conversations');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/ask', async (req, res) => {
  const { question, history = [] } = req.body;
  if (!question) return res.status(400).json({ error: '问题不能为空' });

  // 设置 SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { stream, sources } = await askStream(question, history);  // 传入 history

    // 先发 sources
    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

    // 再流式发正文
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error(err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

app.post('/api/reindex', async (req, res) => {
  res.json({ message: '开始重新索引，请查看终端进度' });
  indexAll().catch(console.error);
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', vault: process.env.VAULT_PATH });
});

// 捕获想法，写入 vault/lab/
app.post('/api/capture', (req, res) => {
  const { content, remind } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
  try {
    const result = createIdea({ content: content.trim(), remind: remind || null });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 获取今日及过期的提醒
app.get('/api/reminders', (req, res) => {
  try {
    res.json(listReminders());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 更新提醒状态（snooze / done / shelved）
app.patch('/api/reminders/:filename', (req, res) => {
  const { filename } = req.params;
  const { status, remind } = req.body;
  try {
    const result = updateReminder(filename, { status, remind });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 本周回顾摘要（24h 缓存，vault 有新文件时自动失效）
app.get('/api/review', async (req, res) => {
  try {
    const data = await getReview();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 保存 / 更新对话
app.post('/api/conversations', (req, res) => {
  try {
    const data = saveConv(req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 对话列表（按更新时间倒序）
app.get('/api/conversations', (req, res) => {
  try {
    res.json(listConvs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单条完整对话
app.get('/api/conversations/:id', (req, res) => {
  const data = getConv(req.params.id);
  if (!data) return res.status(404).json({ error: '对话不存在' });
  res.json(data);
});

// 向 lab 笔记追加讨论记录
app.patch('/api/lab/:filename/discuss', (req, res) => {
  const { question, answer } = req.body;
  if (!question || !answer) return res.status(400).json({ error: '缺少 question 或 answer' });
  try {
    appendDiscussion(req.params.filename, { question, answer });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 读取 vault 内指定笔记
app.get('/api/note', (req, res) => {
  const notePath = req.query.path;
  if (!notePath) return res.status(400).json({ error: 'path 参数不能为空' });

  // 安全校验：必须在 VAULT_PATH 内，禁止 ../ 穿透
  const vaultRoot = path.resolve(process.env.VAULT_PATH);
  const fullPath  = path.resolve(vaultRoot, notePath);
  if (!fullPath.startsWith(vaultRoot + path.sep) && fullPath !== vaultRoot) {
    return res.status(403).json({ error: '路径不合法' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件不存在' });

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({
      content,
      path:  path.relative(vaultRoot, fullPath),
      title: path.basename(notePath, '.md'),
      meta:  `路径：${path.relative(vaultRoot, fullPath)}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  startWatcher();

const fs = require('fs');

app.post('/api/save-memory', async (req, res) => {
  const { question, answer, title } = req.body;
  if (!question || !answer) return res.status(400).json({ error: '内容不能为空' });

  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${date}-${(title || question).slice(0, 20).replace(/[\/\\:*?"<>|]/g, '')}.md`;
  const filePath = `${process.env.VAULT_PATH}/AI对话记忆/${fileName}`;

  // 确保目录存在
  const dir = `${process.env.VAULT_PATH}/AI对话记忆`;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const content = `---
date: ${date}
type: ai-memory
---

## 问题
${question}

## 回答
${answer}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  res.json({ message: '已保存到 vault', file: `AI对话记忆/${fileName}` });
});
});