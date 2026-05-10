const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { askStream }                        = require('./searcher');
const { indexAll }                         = require('./indexer');
const { startWatcher }                     = require('./watcher');
const { createIdea, appendDiscussion, removeDiscussion, listIdeas, getBody, replaceBody } = require('./lab');
const OpenAI = require('openai');
const rewriteClient = new OpenAI({ apiKey: process.env.SILICONFLOW_API_KEY, baseURL: 'https://api.siliconflow.cn/v1' });
const { add: addReminder, listDue, update: updateReminder, remove: removeReminder } = require('./reminders');
const { getReview }                        = require('./reviewer');
const { list: listImaginations, get: getImagination, create: createImagination, append: appendImagination } = require('./imaginations');
const { save: saveConv, list: listConvs, get: getConv, remove: removeConv } = require('./conversations');
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

// 获取全部 lab 想法（Lightning 模式）
app.get('/api/lab', (req, res) => {
  try {
    res.json(listIdeas());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 新增提醒
app.post('/api/reminders', (req, res) => {
  const { content, remind } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
  try {
    res.json(addReminder({ content, remind }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取今日及过期的提醒
app.get('/api/reminders', (req, res) => {
  try {
    res.json(listDue());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 更新提醒（snooze / done）
app.patch('/api/reminders/:id', (req, res) => {
  const { status, remind } = req.body;
  try {
    res.json(updateReminder(req.params.id, { status, remind }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 删除提醒
app.delete('/api/reminders/:id', (req, res) => {
  try {
    removeReminder(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Imaginations
app.get('/api/imaginations', (req, res) => {
  try { res.json(listImaginations()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/imaginations/:filename', (req, res) => {
  try { res.json(getImagination(req.params.filename)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.post('/api/imaginations', (req, res) => {
  const { title, content } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '标题不能为空' });
  try { res.json(createImagination(title, content || '')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/imaginations/:filename', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: '内容不能为空' });
  try { appendImagination(req.params.filename, text); res.json({ ok: true }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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

// 删除对话
app.delete('/api/conversations/:id', (req, res) => {
  try {
    removeConv(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 获取单条完整对话
app.get('/api/conversations/:id', (req, res) => {
  const data = getConv(req.params.id);
  if (!data) return res.status(404).json({ error: '对话不存在' });
  res.json(data);
});

// 向 lab 笔记追加讨论记录，或删除指定条目
app.patch('/api/lab/:filename/discuss', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const { question, answer, action, dateStr } = req.body;

  if (action === 'remove') {
    if (!dateStr) return res.status(400).json({ error: 'dateStr 不能为空' });
    try {
      removeDiscussion(filename, dateStr);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
    return;
  }

  if (!question || !answer) return res.status(400).json({ error: '缺少 question 或 answer' });
  try {
    const result = appendDiscussion(filename, { question, answer });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// 读取 lab 笔记正文（不含讨论记录）
app.get('/api/lab/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  try { res.json(getBody(filename)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// 替换 lab 笔记正文（保留 frontmatter 和讨论记录）
app.put('/api/lab/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: '内容不能为空' });
  try { replaceBody(filename, body); res.json({ ok: true }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// AI 改写 lab 笔记正文
app.post('/api/lab/:filename/rewrite', async (req, res) => {
  req.params.filename = decodeURIComponent(req.params.filename);
  const { currentBody, history = [] } = req.body;
  if (!currentBody) return res.status(400).json({ error: '缺少 currentBody' });
  try {
    const messages = [
      {
        role: 'system',
        content: '你是用户的笔记助手。根据对话内容改写笔记正文。只输出改写后的正文（Markdown），不要加任何解释，不要包含 frontmatter，不要包含讨论记录。',
      },
      {
        role: 'user',
        content: `当前笔记正文：\n\n${currentBody}\n\n---\n\n对话记录：\n\n${history.map(h => `**${h.role === 'user' ? '我' : 'AI'}**：${h.content}`).join('\n\n')}\n\n请根据以上对话，更新笔记正文。`,
      },
    ];
    const completion = await rewriteClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V3.2',
      messages,
      max_tokens: 1200,
    });
    res.json({ body: completion.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
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