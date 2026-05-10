const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const labDir = () => path.join(process.env.VAULT_PATH, 'lab');

function ensureLabDir() {
  const d = labDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function safeLabPath(relPath) {
  const root = path.resolve(labDir());
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root + path.sep) && full !== root) {
    const err = new Error('路径不合法'); err.status = 403; throw err;
  }
  return full;
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
  const filepath = safeLabPath(filename);

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
        const raw = fs.readFileSync(safeLabPath(filename), 'utf-8');
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
  const filepath = safeLabPath(filename);
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
  const filepath = safeLabPath(filename);
  if (!fs.existsSync(filepath)) {
    const err = new Error('文件不存在'); err.status = 404; throw err;
  }

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');

  const entry = [
    '',
    '---',
    '',
    `**Q** · ${dateStr}`,
    '',
    question.trim(),
    '',
    answer.trim(),
    '',
  ].join('\n');

  const raw = fs.readFileSync(filepath, 'utf-8');

  if (!raw.includes('## 讨论记录')) {
    fs.appendFileSync(filepath, '\n\n## 讨论记录\n' + entry, 'utf-8');
  } else {
    fs.appendFileSync(filepath, entry, 'utf-8');
  }

  return { dateStr };
}

function removeDiscussion(filename, dateStr) {
  const filepath = safeLabPath(filename);
  if (!fs.existsSync(filepath)) return;

  let raw = fs.readFileSync(filepath, 'utf-8');
  const marker     = `**Q** · ${dateStr}`;
  const mi         = raw.indexOf(marker);
  if (mi === -1) return;

  const blockStart = raw.lastIndexOf('\n---\n\n', mi);
  if (blockStart === -1) return;

  const nextStart  = raw.indexOf('\n---\n\n', mi + marker.length);
  const blockEnd   = nextStart === -1 ? raw.length : nextStart;

  raw = raw.slice(0, blockStart) + raw.slice(blockEnd);
  raw = raw.replace(/\n\n## 讨论记录\s*$/, '');

  fs.writeFileSync(filepath, raw, 'utf-8');
}

function listIdeas() {
  ensureLabDir();
  const root    = labDir();
  const results = [];

  (function walk(dir, folder) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, folder ? `${folder}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.md')) {
        try {
          const raw  = fs.readFileSync(full, 'utf-8');
          const { meta, content } = parseFrontmatter(raw);
          const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
          const title   = lines[0]?.replace(/^#+\s*/, '').slice(0, 80) || entry.name.replace('.md', '');
          const preview = lines.slice(1).join(' ').slice(0, 140);
          const discussionCount = (content.match(/^### /gm) || []).length;
          results.push({
            id:      folder ? `${folder}/${entry.name}` : entry.name,
            title,
            preview,
            folder:  folder || '',
            status:  meta.status  || 'incubating',
            created: meta.created || '',
            remind:  meta.remind  || null,
            discussionCount,
            content,
          });
        } catch {}
      }
    }
  })(root, '');

  return results.sort((a, b) => b.created.localeCompare(a.created));
}

function getBody(filename) {
  const fp = safeLabPath(filename);
  if (!fs.existsSync(fp)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
  const raw = fs.readFileSync(fp, 'utf-8');
  const { meta, content } = parseFrontmatter(raw);
  const sep = content.indexOf('\n## 讨论记录');
  const body    = sep === -1 ? content : content.slice(0, sep).trim();
  const discuss = sep === -1 ? '' : content.slice(sep);
  return { filename, meta, body, discuss };
}

function replaceBody(filename, newBody) {
  const fp = safeLabPath(filename);
  if (!fs.existsSync(fp)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
  const raw = fs.readFileSync(fp, 'utf-8');
  const { meta, content } = parseFrontmatter(raw);
  const sep     = content.indexOf('\n## 讨论记录');
  const discuss = sep === -1 ? '' : content.slice(sep);
  fs.writeFileSync(fp, stringifyFrontmatter(meta, newBody.trim() + discuss), 'utf-8');
}

module.exports = { createIdea, appendDiscussion, removeDiscussion, listIdeas, getBody, replaceBody };
