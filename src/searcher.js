const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.SILICONFLOW_API_KEY,
  baseURL: 'https://api.siliconflow.cn/v1',
});

const index = new LocalIndex(process.env.INDEX_PATH);

async function search(question) {
  const res = await client.embeddings.create({
    model: 'BAAI/bge-m3',
    input: question,
  });
  const queryVector = res.data[0].embedding;
  const results = await index.queryItems(queryVector, 5);
  return results;
}

async function askStream(question, history = []) {
  const results = await search(question);

  const sources = results.length > 0
    ? [...new Set(results.slice(0, 5).map(r => r.item.metadata.source))]
    : [];

  const context = results.length > 0
    ? results.map((r, i) => `[${i+1}] ${r.item.metadata.text}`).join('\n\n---\n\n')
    : '（未找到相关笔记）';

  // 把历史消息拼进去
  const historyMessages = history.map(h => ({
    role: h.role,
    content: h.content,
  }));

  const stream = await client.chat.completions.create({
    model: 'deepseek-ai/DeepSeek-V3.2',
    stream: true,
    messages: [
      {
        role: 'system',
        content: `你是用户的个人知识助手，拥有用户的笔记作为知识背景。

回答规则：
- 基于笔记内容回答，但不要局限于原文，可以延伸、联想、提出新视角
- 如果笔记内容不足，结合你自己的知识补充，并说明哪部分是补充的
- 回答要精炼，默认控制在300字以内，除非问题明确需要详细展开。如果用户想要更多，他们会追问
- 禁止在正文中出现来源编号（如[1][2]）或任何引用标注，来源会单独展示
- 用 Markdown 格式回答，善用标题、加粗、列表让内容清晰
- 如果用户在追问上一条回答，优先基于对话上下文回答，而不是重新检索`,
      },
      {
        role: 'user',
        content: `笔记背景（仅供参考，对话中可能用不到）：\n\n${context}`,
      },
      {
        role: 'assistant',
        content: '好的，我已了解相关笔记内容。',
      },
      ...historyMessages,  // 插入对话历史
      {
        role: 'user',
        content: question,
      }
    ],
  });

  return { stream, sources };
}

module.exports = { askStream };