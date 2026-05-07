const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data/conversations');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* Normalize role names coming from the frontend (ai → assistant) */
function normalizeMessages(messages) {
  return (messages || []).map(m => ({
    role:    m.role === 'ai' ? 'assistant' : m.role,
    content: m.content,
  }));
}

function save(conv) {
  ensureDir();
  const { id, title, messages } = conv;
  if (!id) throw Object.assign(new Error('id 不能为空'), { status: 400 });

  const filepath = path.join(DATA_DIR, `${id}.json`);
  let existing = null;
  try {
    if (fs.existsSync(filepath)) existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {}

  const normalized = normalizeMessages(messages);
  const firstUser  = normalized.find(m => m.role === 'user');
  const now        = new Date().toISOString();

  const data = {
    id,
    title:     title || (firstUser?.content || '新对话').slice(0, 20),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    messages:  normalized,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

function list() {
  ensureDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
        return {
          id:        data.id,
          title:     data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          preview:   data.messages?.find(m => m.role === 'user')?.content?.slice(0, 60) || '',
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function get(id) {
  const filepath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(filepath)) return null;
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); } catch { return null; }
}

module.exports = { save, list, get };
