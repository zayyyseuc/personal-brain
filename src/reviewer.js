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
    return '本周暂无新增或修改的笔记。';
  }

  const context = files
    .slice(0, 20) // cap at 20 to stay within token budget
    .map(f => `【${f.name}】\n${f.body}`)
    .join('\n\n---\n\n');

  const completion = await client.chat.completions.create({
    model: 'deepseek-ai/DeepSeek-V3.2',
    messages: [
      {
        role: 'system',
        content: '你是用户的个人知识助手，负责生成本周笔记回顾摘要。直接输出摘要，不要加任何前缀或解释。',
      },
      {
        role: 'user',
        content: `以下是本周新增或修改的 ${files.length} 条笔记片段：\n\n${context}\n\n请生成一句简洁的回顾摘要，严格遵循此格式：\n本周新增 X 条笔记，主要围绕**A**、**B**、**C**。有 Y 个主题值得深入讨论。\n\nX 是实际数量，A/B/C 是提炼的 2-3 个核心主题（加粗），Y 是值得继续探讨的主题数。控制在 50 字以内。`,
      },
    ],
    max_tokens: 120,
  });

  return completion.choices[0].message.content.trim();
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

  const files   = getRecentFiles(7);
  const content = await generateSummary(files);
  const result  = { content, fileCount, recentCount: files.length, generatedAt: new Date().toISOString() };
  writeCache(result);
  return result;
}

module.exports = { getReview };
