const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { askStream, askStreamWithFile }      = require('./searcher');
const { indexAll }                         = require('./indexer');
const { startWatcher }                     = require('./watcher');
const { createIdea, appendDiscussion, removeDiscussion, listIdeas, getBody, replaceBody, listFolders, createFolder, moveNote, deleteNote } = require('./lab');
const OpenAI = require('openai');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const rewriteClient = new OpenAI({ apiKey: process.env.SILICONFLOW_API_KEY, baseURL: 'https://api.siliconflow.cn/v1', timeout: 30000 });
const ocrClient = new OpenAI({ apiKey: process.env.SILICONFLOW_API_KEY, baseURL: 'https://api.siliconflow.cn/v1', timeout: 30000 });
const momClient  = new OpenAI({ apiKey: process.env.SILICONFLOW_API_KEY, baseURL: 'https://api.siliconflow.cn/v1', timeout: 30000 });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { add: addReminder, listDue, update: updateReminder, remove: removeReminder } = require('./reminders');
const { getReview }                        = require('./reviewer');
const { list: listImaginations, get: getImagination, create: createImagination, append: appendImagination } = require('./imaginations');
const { save: saveConv, list: listConvs, get: getConv, remove: removeConv } = require('./conversations');
const { momIndex, ensureIndex: ensureMomIndex, getPublicFiles, stripFrontmatter } = require('./mom-indexer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── 活动打点：记录 Zia 使用 personal-brain 的频次，供热力图使用 ──
const DATA_DIR = path.join(__dirname, '../data');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

function recordActivity() {
  const today = new Date().toISOString().slice(0, 10);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8')); } catch {}
  data[today] = (data[today] || 0) + 1;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data));
  } catch {}
}

app.use((req, res, next) => {
  // 只记录 Zia 自己的操作，排除妈妈端和心跳
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/mom') && req.path !== '/api/health') {
    recordActivity();
  }
  next();
});

app.post('/api/ask', async (req, res) => {
  const { question, history = [] } = req.body;
  if (!question) return res.status(400).json({ error: '问题不能为空' });

  const t0 = Date.now();
  const logEntry = { q: question.slice(0, 60), model: 'deepseek-ai/DeepSeek-V4-Flash' };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const { stream, sources } = await askStream(question, history);
    clearInterval(heartbeat);

    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      if (chunk.usage) {
        logEntry.usage = chunk.usage;
        res.write(`data: ${JSON.stringify({ type: 'usage', usage: chunk.usage })}\n\n`);
      }
    }

    logEntry.ok = true;
    logEntry.ms = Date.now() - t0;
    pushLog(logEntry);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    logEntry.ok = false;
    logEntry.ms = Date.now() - t0;
    logEntry.error = err.message;
    pushLog(logEntry);
    console.error(err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

async function ocrImage(buffer, mimetype) {
  const b64 = buffer.toString('base64');
  const stream = await ocrClient.chat.completions.create({
    model: 'Qwen/Qwen3-VL-8B-Instruct',
    stream: true,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } },
        { type: 'text', text: '请提取图片中所有文字内容，保持原有结构。如有图表或表格，用文字描述其含义。如果没有文字，描述图片的主要内容。' }
      ]
    }]
  });
  let content = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) content += delta;
  }
  // 剥掉 thinking 模型的推理标签，只保留最终答案
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

app.post('/api/ask-with-file', upload.array('files', 6), async (req, res) => {
  console.log('[ask-with-file] req.body keys:', Object.keys(req.body || {}));
  console.log('[ask-with-file] files count:', (req.files || []).length);
  console.log('[ask-with-file] historyRaw length:', req.body?.history?.length, 'type:', typeof req.body?.history);
  const { question, history: historyRaw } = req.body || {};
  const files = req.files || [];

  if (!question) return res.status(400).json({ error: '问题不能为空' });

  const hasPdf = files.some(f => f.mimetype === 'application/pdf');
  const hasImage = files.some(f => f.mimetype.startsWith('image/'));

  if (hasPdf && hasImage) {
    return res.status(400).json({ error: '不能同时上传图片和 PDF' });
  }
  if (files.filter(f => f.mimetype === 'application/pdf').length > 1) {
    return res.status(400).json({ error: '最多上传 1 份 PDF' });
  }

  let fileContext = '';

  try {
    if (hasPdf) {
      const pdfFile = files[0];
      const data = await pdfParse(pdfFile.buffer);
      const text = data.text.trim();
      if (text.length < 50) {
        return res.status(400).json({ error: '此 PDF 为扫描版，暂不支持，请使用含文字的 PDF' });
      }
      fileContext = `【PDF文件：${pdfFile.originalname}】\n\n${text}`;
    } else if (hasImage) {
      const ocrResults = await Promise.all(
        files.map(async (f, i) => {
          const text = await ocrImage(f.buffer, f.mimetype);
          return `【图片${i + 1}：${f.originalname}】\n${text}`;
        })
      );
      fileContext = ocrResults.join('\n\n---\n\n');
    }
  } catch (err) {
    console.error('[文件处理] 完整错误:', err);
    return res.status(500).json({ error: `文件处理失败：${err.message}` });
  }

  console.log('[ask-with-file] fileContext length:', fileContext.length);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const heartbeatFile = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    console.log('[ask-with-file] parsing history...');
    const history = historyRaw ? JSON.parse(historyRaw) : [];
    console.log('[ask-with-file] history parsed, length:', history.length);
    const { stream, sources } = await askStreamWithFile(question, fileContext, history);
    clearInterval(heartbeatFile);

    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    clearInterval(heartbeatFile);
    console.error('[ask-with-file] SSE阶段错误:', err.constructor.name, err.message);
    console.error('[ask-with-file] 错误堆栈:', err.stack);
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
  console.log('[conv] save id:', req.body?.id, 'msgs:', req.body?.messages?.length);
  try {
    const data = saveConv(req.body);
    res.json(data);
  } catch (err) {
    console.error('[conv] save error:', err.message);
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

// Lab 文件夹列表
app.get('/api/lab-folders', (req, res) => {
  try { res.json(listFolders()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 新建 lab 文件夹
app.post('/api/lab-folders', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '文件夹名不能为空' });
  try { res.json(createFolder(name)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// 移动 lab 笔记到指定文件夹（folder 为空字符串 = 移回根目录）
app.patch('/api/lab/:filename/move', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const { folder } = req.body;
  if (folder === undefined) return res.status(400).json({ error: '缺少 folder 参数' });
  try { res.json(moveNote(filename, folder)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// 删除 lab 笔记
app.delete('/api/lab/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  try { deleteNote(filename); res.json({ ok: true }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
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
        content: `你是用户非常了解她的老朋友，在帮她整理和更新她的笔记。你的语气是温暖、直接、口语化的，像朋友之间说话，不像AI在生成报告。
写作风格要求：
- 用"你"而不是"用户"，用第一人称视角帮她记录
- 可以有自己的观点和感受，比如"我觉得这个想法很有意思"、"这一块我有点担心你想清楚了吗"
- 不要过度结构化，不要堆砌标题和子标题，自然地组织内容
- 只输出改写后的正文（Markdown），不要加任何解释，不要包含 frontmatter，不要包含讨论记录`,
      },
      {
        role: 'user',
        content: `当前笔记正文：\n\n${currentBody}\n\n---\n\n对话记录：\n\n${history.map(h => `**${h.role === 'user' ? '我' : 'AI'}**：${h.content}`).join('\n\n')}\n\n请根据以上对话，用朋友的口吻更新笔记正文。`,
      },
    ];
    const completion = await rewriteClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
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

// ── Mom PWA ───────────────────────────────────────────────────────────────────

const MOM_STATUS_FILE    = path.join(DATA_DIR, 'mom-status.json');
const MOM_MILESTONES_FILE = path.join(DATA_DIR, 'milestones.json');

const MOM_SYSTEM_PROMPT = `你是 Zia 的助手，帮 Zia 的妈妈了解 Zia 最近在做什么。只用 Zia 分享的内容来回答，用温柔、亲切的中文，不要太正式。如果不知道，就说不太清楚这个，不要编造。回答要简短，一两句话就好。`;

// 状态卡片：读取
app.get('/api/mom-status', (req, res) => {
  try {
    const data = fs.existsSync(MOM_STATUS_FILE)
      ? JSON.parse(fs.readFileSync(MOM_STATUS_FILE, 'utf-8'))
      : { text: '', updatedAt: null };
    res.json(data);
  } catch { res.json({ text: '', updatedAt: null }); }
});

// 状态卡片：更新（Zia 在自己界面用）
app.post('/api/mom-status', (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: '状态不能为空' });
  const data = { text: text.trim(), updatedAt: new Date().toISOString() };
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MOM_STATUS_FILE, JSON.stringify(data));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 热力图：过去 30 天活跃度
app.get('/api/mom-activity', (req, res) => {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8')); } catch {}
  const result = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result[key] = raw[key] || 0;
  }
  res.json(result);
});

// 最近分享的笔记（frontmatter public: true，按修改时间倒序取 3 篇）
app.get('/api/mom-notes', (req, res) => {
  try {
    const files = getPublicFiles();
    const notes = files
      .map(f => ({ f, mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3)
      .map(({ f, mtime }) => {
        const content = fs.readFileSync(f, 'utf-8');
        const body = stripFrontmatter(content);
        const title = path.basename(f, '.md');
        const excerpt = body.replace(/#+\s*/g, '').trim().slice(0, 150);
        return { title, excerpt, updatedAt: new Date(mtime).toISOString() };
      });
    res.json(notes);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 大事倒计时
app.get('/api/mom-milestones', (req, res) => {
  try {
    const data = fs.existsSync(MOM_MILESTONES_FILE)
      ? JSON.parse(fs.readFileSync(MOM_MILESTONES_FILE, 'utf-8'))
      : [];
    const now = Date.now();
    const result = data.map(m => ({
      label: m.label,
      date: m.date,
      daysLeft: Math.ceil((new Date(m.date).getTime() - now) / 86400000),
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 触发妈妈专属索引重建
app.post('/api/mom-reindex', async (req, res) => {
  res.json({ message: '开始重建妈妈专属索引' });
  const { indexAll: momIndexAll } = require('./mom-indexer');
  momIndexAll().catch(console.error);
});

// 问问 Zia（SSE 流式）
app.post('/api/mom-ask', async (req, res) => {
  const { question, history = [] } = req.body;
  if (!question) return res.status(400).json({ error: '问题不能为空' });

  const t0 = Date.now();
  const logEntry = { q: question.slice(0, 80), model: 'deepseek-ai/DeepSeek-V4-Flash' };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    await ensureMomIndex();

    const te0 = Date.now();
    const embedRes = await momClient.embeddings.create({ model: 'BAAI/bge-m3', input: question });
    logEntry.embedMs = Date.now() - te0;

    const results = await momIndex.queryItems(embedRes.data[0].embedding, 5);
    logEntry.contextChunks = results.length;
    const context = results.slice(0, 5).map(r => r.item.metadata.text).join('\n\n---\n\n');

    const sysPrompt = context
      ? `${MOM_SYSTEM_PROMPT}\n\n以下是 Zia 分享的内容，作为回答依据：\n\n${context}`
      : MOM_SYSTEM_PROMPT;

    const tc0 = Date.now();
    const stream = await momClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: sysPrompt }, ...history, { role: 'user', content: question }],
    });

    clearInterval(heartbeat);
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
      if (chunk.usage) {
        logEntry.usage = chunk.usage;
        logEntry.chatMs = Date.now() - tc0;
        res.write(`data: ${JSON.stringify({ type: 'usage', usage: chunk.usage })}\n\n`);
      }
    }

    logEntry.ok = true;
    logEntry.ms = Date.now() - t0;
    pushMomLog(logEntry);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    clearInterval(heartbeat);
    logEntry.ok = false;
    logEntry.ms = Date.now() - t0;
    logEntry.error = err.message;
    pushMomLog(logEntry);
    console.error('[mom-ask]', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') })}\n\n`);
    res.end();
  }
});

// Mom 诊断：模型可用性 + 索引状态 + 公开笔记数
app.get('/api/mom-health', async (req, res) => {
  const results = {};

  const te0 = Date.now();
  try {
    await healthClient.embeddings.create({ model: 'BAAI/bge-m3', input: 'ping' });
    results.embed = { ok: true, ms: Date.now() - te0, model: 'BAAI/bge-m3' };
  } catch (err) {
    results.embed = { ok: false, ms: Date.now() - te0, error: err.message };
  }

  const tc0 = Date.now();
  try {
    await healthClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    results.chat = { ok: true, ms: Date.now() - tc0, model: 'deepseek-ai/DeepSeek-V4-Flash' };
  } catch (err) {
    results.chat = { ok: false, ms: Date.now() - tc0, error: err.message };
  }

  try {
    const files = getPublicFiles();
    results.publicNotes = { count: files.length, files: files.map(f => path.basename(f)) };
  } catch (err) {
    results.publicNotes = { count: 0, error: err.message };
  }

  try {
    const indexed = await momIndex.isIndexCreated();
    results.momIndex = { created: indexed };
    if (indexed) {
      const items = await momIndex.listItems();
      results.momIndex.chunks = items.length;
    }
  } catch (err) {
    results.momIndex = { error: err.message };
  }

  res.json(results);
});

// Mom 请求日志
app.get('/api/mom-debug', (req, res) => res.json(momLog));

// /mom 静态文件 + 路由
app.use('/mom', express.static(path.join(__dirname, '../public/mom')));
app.get('/mom', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mom/index.html'));
});

// multer 错误处理：返回 JSON 而不是 HTML
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: '图片过大，单张限 20MB' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: '最多上传 6 张图片' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: '文件字段名不对，请刷新页面重试' });
  }
  console.error('[未处理错误]', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ── 请求日志（内存，最近 20 条）──────────────────────────────
const reqLog = [];
function pushLog(entry) {
  reqLog.unshift({ ...entry, time: new Date().toISOString() });
  if (reqLog.length > 20) reqLog.pop();
}

// ── Mom 专属日志（内存，最近 30 条）──────────────────────────
const momLog = [];
function pushMomLog(entry) {
  momLog.unshift({ ...entry, time: new Date().toISOString() });
  if (momLog.length > 30) momLog.pop();
}

// 健康检查（单独短超时 client，不影响主流程）
const healthClient = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
  timeout: 12000,
});

app.get('/api/health', async (req, res) => {
  const results = {};

  const t0 = Date.now();
  try {
    await healthClient.embeddings.create({ model: 'BAAI/bge-m3', input: 'ping' });
    results.embed = { ok: true, ms: Date.now() - t0, model: 'BAAI/bge-m3' };
  } catch (err) {
    results.embed = { ok: false, ms: Date.now() - t0, model: 'BAAI/bge-m3', error: err.message };
  }

  const t1 = Date.now();
  try {
    await healthClient.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    results.chat = { ok: true, ms: Date.now() - t1, model: 'deepseek-ai/DeepSeek-V4-Flash' };
  } catch (err) {
    results.chat = { ok: false, ms: Date.now() - t1, model: 'deepseek-ai/DeepSeek-V4-Flash', error: err.message };
  }

  res.json(results);
});

app.get('/api/debug', (req, res) => res.json(reqLog));

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