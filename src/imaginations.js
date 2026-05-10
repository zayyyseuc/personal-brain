const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const imagDir = () => path.join(process.env.VAULT_PATH, 'imaginations');

function ensureDir() {
  const d = imagDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  m[1].split('\n').forEach(line => {
    const c = line.indexOf(':');
    if (c < 1) return;
    meta[line.slice(0, c).trim()] = line.slice(c + 1).trim();
  });
  return { meta, body: m[2].trim() };
}

function list() {
  ensureDir();
  return fs.readdirSync(imagDir())
    .filter(f => f.endsWith('.md'))
    .map(filename => {
      try {
        const raw  = fs.readFileSync(path.join(imagDir(), filename), 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        const title   = filename.replace(/\.md$/, '');
        const preview = body.replace(/\n+/g, ' ').slice(0, 120);
        return { id: filename, title, preview, created: meta.created || '' };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.created.localeCompare(a.created));
}

function get(filename) {
  const fp = path.join(imagDir(), filename);
  if (!fs.existsSync(fp)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
  const raw = fs.readFileSync(fp, 'utf-8');
  const { body } = parseFrontmatter(raw);
  return { id: filename, title: filename.replace(/\.md$/, ''), content: body };
}

function create(title, content) {
  ensureDir();
  const date     = new Date().toISOString().slice(0, 10);
  const safe     = (title || '想法').replace(/[\/\\:*?"<>|]/g, '').trim().slice(0, 40) || '想法';
  const filename = `${safe}.md`;
  const fp       = path.join(imagDir(), filename);
  const fm = `---\ntype: imagination\ncreated: ${date}\n---\n\n${(content || '').trim()}\n`;
  fs.writeFileSync(fp, fm, 'utf-8');
  return { id: filename, title: safe };
}

function append(filename, text) {
  const fp = path.join(imagDir(), filename);
  if (!fs.existsSync(fp)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(fp, `\n\n---\n\n_${date}_\n\n${text.trim()}\n`, 'utf-8');
}

module.exports = { list, get, create, append };
