const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const index = new LocalIndex(process.env.INDEX_PATH);

async function ensureIndex() {
  if (!await index.isIndexCreated()) {
    await index.createIndex();
  }
}

// 把一篇笔记切成若干块，每块约 500 字
function chunkText(text, filePath) {
  const chunks = [];
  const lines = text.split('\n');
  let current = '';
  let lineStart = 0;

  for (let i = 0; i < lines.length; i++) {
    current += lines[i] + '\n';
    if (current.length >= 500) {
      chunks.push({ text: current.trim(), source: filePath, chunkIndex: chunks.length });
      current = '';
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), source: filePath, chunkIndex: chunks.length });
  }
  return chunks;
}

async function embedText(text) {
  const res = await client.embeddings.create({
    model: 'BAAI/bge-m3',
    input: text,
  });
  return res.data[0].embedding;
}

async function indexFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = path.relative(process.env.VAULT_PATH, filePath);
  const chunks = chunkText(content, relativePath);

  // 先删除这个文件已有的旧条目
  const existing = await index.listItemsByMetadata({ source: relativePath });
  for (const item of existing) {
    await index.deleteItem(item.id);
  }

  // 写入新条目
  for (const chunk of chunks) {
    const vector = await embedText(chunk.text);
    await index.insertItem({
      vector,
      metadata: {
        text: chunk.text,
        source: chunk.source,
        chunkIndex: chunk.chunkIndex,
      }
    });
  }

  console.log(`已索引: ${relativePath} (${chunks.length} 块)`);
}

async function indexAll() {
  await ensureIndex();
  const files = getAllMarkdownFiles(process.env.VAULT_PATH);
  console.log(`发现 ${files.length} 个笔记文件，开始索引...`);
  for (const file of files) {
    await indexFile(file);
  }
  console.log('全量索引完成');
}

function getAllMarkdownFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      results.push(...getAllMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

module.exports = { indexFile, indexAll, ensureIndex };