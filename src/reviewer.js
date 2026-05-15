const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const CACHE_DIR  = path.join(__dirname, '../cache');
const CACHE_FILE = path.join(CACHE_DIR, 'review.json');
const TTL_MS     = 24 * 60 * 60 * 1000;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { return null; }
}

function writeCache(data) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/* Count total .md files in vault */
function countVaultFiles() {
  const vaultPath = process.env.VAULT_PATH;
  let n = 0;
  (function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name));
        else if (entry.name.endsWith('.md')) n++;
      }
    } catch {}
  })(vaultPath);
  return n;
}

/* Return files modified within the last `days` days */
function getRecentFiles(days = 7) {
  const vaultPath = process.env.VAULT_PATH;
  const since = Date.now() - days * 86400_000;
  const files = [];

  (function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.md')) continue;
        const stat = fs.statSync(full);
        if (stat.mtimeMs < since) continue;
        const raw = fs.readFileSync(full, 'utf-8');
        // Strip frontmatter, take first 300 chars of body
        const body = raw.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 300);
        files.push({ name: entry.name.replace(/\.md$/, ''), body, mtime: stat.mtimeMs });
      }
    } catch {}
  })(vaultPath);

  return files.sort((a, b) => b.mtime - a.mtime);
}

async function generateSummary(files) {
  if (files.length === 0) {
    return { summary: '本周暂无新增或修改的笔记。', tags: [] };
  }

  const context = files
    .slice(0, 20)
    .map(f => `【${f.name}】\n${f.body}`)
    .join('\n\n---\n\n');

  const completion = await client.chat.completions.create({
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    messages: [
      {
        role: 'system',
        content: '你是用户的个人知识助手，负责生成本周笔记回顾摘要。只输出 JSON，不加任何额外文字。',
      },
      {
        role: 'user',
        content: `以下是本周新增或修改的 ${files.length} 条笔记片段：\n\n${context}\n\n请返回如下 JSON（不要加代码块标记）：\n{"summary":"本周新增 X 条笔记，主要围绕**A**、**B**、**C**。","tags":["话题1","话题2","话题3"],"question":"一个值得长时间思考的开放性问题？"}\n\n规则：summary 中 X 是实际数量，A/B/C 是 2-3 个核心主题（加粗），控制在 40 字以内；tags 是 3-6 个值得深入探讨的关键词，每个不超过 8 字；question 是从笔记中提炼的一个最值得深度思考的开放性问题，一句话，20 字以内，以问号结尾。`,
      },
    ],
    max_tokens: 200,
  });

  const raw = completion.choices[0].message.content.trim().replace(/^```json?\n?|```$/g, '');
  try {
    const parsed = JSON.parse(raw);
    return {
      summary:  parsed.summary  || '',
      tags:     Array.isArray(parsed.tags) ? parsed.tags : [],
      question: parsed.question || '',
    };
  } catch {
    // Malformed JSON fallback: extract tags array and question via regex
    const tagsMatch    = raw.match(/"tags"\s*:\s*\[([^\]]+)\]/);
    const questionMatch = raw.match(/"question"\s*:\s*"([^"]+)"/);
    const summaryMatch = raw.match(/"summary"\s*:\s*"([^"]+)"/);
    const tags = tagsMatch
      ? tagsMatch[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) ?? []
      : [];
    return {
      summary:  summaryMatch ? summaryMatch[1] : raw,
      tags,
      question: questionMatch ? questionMatch[1] : '',
    };
  }
}

async function getReview() {
  const fileCount = countVaultFiles();
  const cache = readCache();

  if (cache) {
    const age = Date.now() - new Date(cache.generatedAt).getTime();
    if (age < TTL_MS && cache.fileCount === fileCount) {
      return cache; // still fresh
    }
  }

  const files                    = getRecentFiles(7);
  const { summary, tags, question } = await generateSummary(files);
  const result  = { content: summary, tags, question, fileCount, recentCount: files.length, generatedAt: new Date().toISOString() };
  writeCache(result);
  return result;
}

module.exports = { getReview };
