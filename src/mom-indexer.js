const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const momIndex = new LocalIndex(
  process.env.MOM_INDEX_PATH || path.join(__dirname, '../mom-index')
);

function getExcludedFolders() {
  return (process.env.MOM_EXCLUDED_FOLDERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isPublicNote(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return /public:\s*true/i.test(fm[1]);
}

function isExcluded(filePath) {
  const excluded = getExcludedFolders();
  if (!excluded.length) return false;
  const rel = path.relative(process.env.VAULT_PATH, filePath);
  return excluded.some(folder =>
    rel === folder ||
    rel.startsWith(folder + path.sep) ||
    rel.startsWith(folder + '/')
  );
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function getAllMarkdownFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      results.push(...getAllMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function getPublicFiles() {
  return getAllMarkdownFiles(process.env.VAULT_PATH).filter(f => {
    if (isExcluded(f)) return false;
    try { return isPublicNote(fs.readFileSync(f, 'utf-8')); } catch { return false; }
  });
}

function chunkText(text, source) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    current += line + '\n';
    if (current.length >= 500) {
      chunks.push({ text: current.trim(), source, chunkIndex: chunks.length });
      current = '';
    }
  }
  if (current.trim()) chunks.push({ text: current.trim(), source, chunkIndex: chunks.length });
  return chunks;
}

async function embed(text) {
  const res = await client.embeddings.create({ model: 'BAAI/bge-m3', input: text });
  return res.data[0].embedding;
}

async function ensureIndex() {
  if (!await momIndex.isIndexCreated()) await momIndex.createIndex();
}

async function indexFile(filePath) {
  await ensureIndex();
  const content = fs.readFileSync(filePath, 'utf-8');
  const rel = path.relative(process.env.VAULT_PATH, filePath);

  // 如果文件不再满足条件，从索引中移除
  if (!isPublicNote(content) || isExcluded(filePath)) {
    const existing = await momIndex.listItemsByMetadata({ source: rel });
    for (const item of existing) await momIndex.deleteItem(item.id);
    return;
  }

  const body = stripFrontmatter(content);
  const chunks = chunkText(body, rel);

  const existing = await momIndex.listItemsByMetadata({ source: rel });
  for (const item of existing) await momIndex.deleteItem(item.id);

  for (const chunk of chunks) {
    const vector = await embed(chunk.text);
    await momIndex.insertItem({ vector, metadata: { text: chunk.text, source: chunk.source, chunkIndex: chunk.chunkIndex } });
  }
  console.log(`[mom-index] 已索引: ${rel} (${chunks.length} 块)`);
}

async function indexAll() {
  await ensureIndex();
  const files = getPublicFiles();
  console.log(`[mom-index] 发现 ${files.length} 篇 public 笔记，开始索引…`);
  for (const f of files) await indexFile(f);
  console.log('[mom-index] 全量索引完成');
}

module.exports = { momIndex, ensureIndex, indexFile, indexAll, getPublicFiles, isPublicNote, isExcluded, stripFrontmatter };
