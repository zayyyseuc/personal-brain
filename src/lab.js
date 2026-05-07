const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const labDir = () => path.join(process.env.VAULT_PATH, 'lab');

function ensureLabDir() {
  const d = labDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ---------- Frontmatter helpers ---------- */

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, content: raw.trim() };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const colon = line.indexOf(':');
    if (colon < 1) return;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  });
  return { meta, content: m[2].trim() };
}

function stringifyFrontmatter(meta, content) {
  const fm = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fm}\n---\n\n${content}\n`;
}

/* ---------- Slug ---------- */

function slugify(text) {
  return text
    .slice(0, 24)
    .replace(/[\s\/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'idea';
}

/* ---------- Public API ---------- */

function createIdea({ content, remind }) {
  ensureLabDir();
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const hhmm = now.toTimeString().slice(0, 5).replace(':', '');
  const slug = slugify(content);
  const filename = `${date}-${hhmm}-${slug}.md`;
  const filepath = path.join(labDir(), filename);

  const meta = { type: 'idea', status: 'incubating', created: date };
  if (remind) meta.remind = remind;

  fs.writeFileSync(filepath, stringifyFrontmatter(meta, content), 'utf-8');
  return { id: filename, remind: remind || null };
}

function listReminders() {
  ensureLabDir();
  const today = new Date().toISOString().slice(0, 10);

  return fs.readdirSync(labDir())
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      try {
        const raw = fs.readFileSync(path.join(labDir(), filename), 'utf-8');
        const { meta, content } = parseFrontmatter(raw);
        return { id: filename, meta, content };
      } catch { return null; }
    })
    .filter(item => {
      if (!item) return false;
      const { meta } = item;
      if (!meta.remind) return false;
      if (meta.status === 'done' || meta.status === 'shelved') return false;
      return meta.remind <= today;
    })
    .map(({ id, meta, content }) => ({
      id,
      title:   content.split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) || id.replace('.md', ''),
      preview: content.replace(/\n+/g, ' ').slice(0, 80),
      remind:  meta.remind,
      status:  meta.status || 'incubating',
      created: meta.created || '',
    }));
}

function updateReminder(filename, { status, remind }) {
  const filepath = path.join(labDir(), filename);
  if (!fs.existsSync(filepath)) {
    const err = new Error('笔记不存在'); err.status = 404; throw err;
  }

  const raw = fs.readFileSync(filepath, 'utf-8');
  const { meta, content } = parseFrontmatter(raw);

  if (status !== undefined) meta.status = status;
  if (remind  !== undefined) {
    if (remind === null) delete meta.remind;
    else meta.remind = remind;
  }

  fs.writeFileSync(filepath, stringifyFrontmatter(meta, content), 'utf-8');
  return { id: filename, ...meta };
}

/* ---------- Append Q&A discussion to a lab note ---------- */

function appendDiscussion(filename, { question, answer }) {
  const filepath = path.join(labDir(), filename);
  if (!fs.existsSync(filepath)) {
    const err = new Error('文件不存在'); err.status = 404; throw err;
  }

  const now     = new Date();
  const dateStr = now.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const entry = [
    '',
    `### ${dateStr}`,
    '',
    `**Q：** ${question.trim()}`,
    '',
    answer.trim().split('\n').map(l => l).join('\n'), // preserve markdown
    '',
  ].join('\n');

  const raw = fs.readFileSync(filepath, 'utf-8');

  if (!raw.includes('## 讨论记录')) {
    fs.appendFileSync(filepath, '\n\n## 讨论记录\n' + entry, 'utf-8');
  } else {
    fs.appendFileSync(filepath, '\n---\n' + entry, 'utf-8');
  }
}

module.exports = { createIdea, listReminders, updateReminder, appendDiscussion };
