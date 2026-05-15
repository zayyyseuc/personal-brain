const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { fetchWebContext } = require('./web-search');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
  timeout: 30000,
});

const index = new LocalIndex(process.env.INDEX_PATH);

function loadPersona() {
  const personaPath = path.join(__dirname, '../persona.md');
  try {
    return fs.readFileSync(personaPath, 'utf-8').trim();
  } catch {
    return '你是用户的个人知识助手，拥有用户的笔记作为知识背景。';
  }
}

const PERSONA = loadPersona();

async function search(question) {
  try {
    const res = await client.embeddings.create({
      model: 'BAAI/bge-m3',
      input: question,
    });
    const queryVector = res.data[0].embedding;
    const results = await index.queryItems(queryVector, 5);
    return results.slice(0, 5);
  } catch (err) {
    console.error('[embed] 向量检索失败，跳过笔记背景:', err.message);
    return [];
  }
}

// Decide if the current message warrants a web search, and what to search for.
// Runs a small non-streaming call; resolves quickly (<1s typical).
async function detectSearchNeed(question, history = []) {
  const recent = history.slice(-4).map(h => `${h.role === 'user' ? '用户' : 'AI'}: ${h.content}`).join('\n');
  const prompt = recent ? `${recent}\n用户: ${question}` : question;

  try {
    const res = await client.chat.completions.create({
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      stream: false,
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: `你是一个搜索决策器。判断用户的消息是否需要联网搜索才能很好地回应。
需要搜索的情况：用户提到了具体的影视作品、音乐、新闻、产品、人物、近期事件，或分享了你可能不了解的具体内容（如"我在看xx"、"最近有部剧"）。
不需要搜索的情况：纯聊感受、问笔记内容、一般性闲聊、抽象话题讨论。
只返回 JSON，不加任何其他内容：{"need": true或false, "query": "搜索词"}`,
        },
        { role: 'user', content: prompt },
      ],
    });

    const raw = res.choices[0].message.content.trim().replace(/^```json?\n?|```$/g, '');
    const parsed = JSON.parse(raw);
    return { need: !!parsed.need, query: parsed.query || question };
  } catch (err) {
    console.error('[detect] 失败:', err.message);
    return { need: false, query: '' };
  }
}

async function askStream(question, history = []) {
  // Start vault search immediately; run detection in parallel
  const vaultPromise = search(question);
  const detectPromise = detectSearchNeed(question, history);

  // Once detection resolves, fire web search right away (don't wait for vault)
  // Hard cap at 5s so a slow/blocked external search never stalls the main stream
  const webSearchPromise = detectPromise.then(({ need, query }) => {
    if (!need) return null;
    console.log(`\n[联网] 检测到需要搜索: "${query}"`);
    return fetchWebContext(query).then(r => r ? { ...r, query } : null);
  });
  const webPromise = Promise.race([
    webSearchPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 5000)),
  ]);

  // Wait for all three in parallel
  const [results, webResult] = await Promise.all([vaultPromise, webPromise]);
  const webQuery = webResult?.query || '';

  const noteSources = results.length > 0
    ? [...new Set(results.slice(0, 5).map(r => r.item.metadata.source))]
    : [];

  const sources = [
    ...noteSources,
    ...(webResult ? webResult.webSources : []),
  ];

  console.log(`\n[检索] "${question}"`);
  results.forEach((r, i) => {
    console.log(`  [${i+1}] ${r.item.metadata.source} (score: ${r.score.toFixed(3)})`);
  });

  const noteContext = results.length > 0
    ? results.map((r, i) => `[${i+1}] ${r.item.metadata.text}`).join('\n\n---\n\n')
    : '（未找到相关笔记）';

  const systemExtra = webResult
    ? `\n\n---\n\n以下是联网搜索到的相关信息（搜索词："${webQuery}"），可用来回答用户提到的具体内容：\n\n${webResult.context}`
    : '';

  const historyMessages = history.map(h => ({ role: h.role, content: h.content }));

  const stream = await client.chat.completions.create({
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    stream: true,
    messages: [
      {
        role: 'system',
        content: PERSONA + systemExtra,
      },
      {
        role: 'user',
        content: `笔记背景（仅供参考，对话中可能用不到）：\n\n${noteContext}`,
      },
      {
        role: 'assistant',
        content: '好的，我已了解相关笔记内容。',
      },
      ...historyMessages,
      {
        role: 'user',
        content: question,
      }
    ],
  });

  return { stream, sources };
}

async function askStreamWithFile(question, fileContext, history = []) {
  const results = await search(question);

  const sources = results.length > 0
    ? [...new Set(results.slice(0, 5).map(r => r.item.metadata.source))]
    : [];

  console.log(`\n[检索+文件] "${question}"`);
  results.forEach((r, i) => {
    console.log(`  [${i+1}] ${r.item.metadata.source} (score: ${r.score.toFixed(3)})`);
  });

  const context = results.length > 0
    ? results.map((r, i) => `[${i+1}] ${r.item.metadata.text}`).join('\n\n---\n\n')
    : '（未找到相关笔记）';

  const historyMessages = history.map(h => ({
    role: h.role,
    content: h.content,
  }));

  const stream = await client.chat.completions.create({
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    stream: true,
    messages: [
      {
        role: 'system',
        content: `${PERSONA}\n\n---\n\n用户上传了文件，优先基于文件内容回答，再结合笔记背景补充。文件内容：\n\n${fileContext}`,
      },
      {
        role: 'user',
        content: `笔记背景（仅供参考）：\n\n${context}`,
      },
      {
        role: 'assistant',
        content: '好的，我已了解相关笔记内容和上传的文件。',
      },
      ...historyMessages,
      {
        role: 'user',
        content: question,
      }
    ],
  });

  return { stream, sources };
}

module.exports = { askStream, askStreamWithFile };