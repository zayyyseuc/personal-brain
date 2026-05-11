/**
 * One-time import: Claude export → vault/claude-import/
 * Run: node src/import-claude.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const EXPORT_DIR = '/Users/chen/Downloads/data-727e5d7b-ef53-4f85-bdb4-45abdca14c5a-1778478333-9c09e1f8-batch-0000';
const VAULT_DIR  = path.join(process.env.VAULT_PATH, 'claude-import');
const CONV_DIR   = path.join(VAULT_DIR, 'conversations');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function safeName(str) {
  return (str || 'untitled')
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/* ---------- 1. memories.json ---------- */
function importMemory() {
  const raw  = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'memories.json'), 'utf-8'));
  const text = raw[0]?.conversations_memory || '';
  if (!text) { console.log('memories.json: empty, skipped'); return; }

  ensureDir(VAULT_DIR);
  const out = `---\ntype: claude-memory\nimported: ${new Date().toISOString().slice(0,10)}\n---\n\n${text}\n`;
  fs.writeFileSync(path.join(VAULT_DIR, 'claude-memory.md'), out, 'utf-8');
  console.log('✓ claude-memory.md');
}

/* ---------- 2. conversations.json (summary only) ---------- */
function importConversations() {
  const convs = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'conversations.json'), 'utf-8'));
  ensureDir(CONV_DIR);

  let count = 0;
  for (const c of convs) {
    const summary = (c.summary || '').trim();
    if (!summary) continue;

    const date  = (c.created_at || '').slice(0, 10);
    const title = safeName(c.name);
    const fname = `${date}-${title}.md`;

    const content = `---\ntype: claude-conversation\ndate: ${date}\ntitle: "${title.replace(/"/g, '')}"\n---\n\n# ${c.name || title}\n\n${summary}\n`;
    fs.writeFileSync(path.join(CONV_DIR, fname), content, 'utf-8');
    count++;
  }
  console.log(`✓ ${count} conversations imported`);
}

/* ---------- 3. projects/ ---------- */
function importProjects() {
  const projDir = path.join(EXPORT_DIR, 'projects');
  if (!fs.existsSync(projDir)) return;

  const files = fs.readdirSync(projDir).filter(f => f.endsWith('.json'));
  ensureDir(path.join(VAULT_DIR, 'projects'));

  let count = 0;
  for (const file of files) {
    const p = JSON.parse(fs.readFileSync(path.join(projDir, file), 'utf-8'));
    const hasContent = p.name || p.description || (p.docs && p.docs.length) || p.prompt_template;
    if (!hasContent) continue;

    const title   = safeName(p.name || file.replace('.json', ''));
    const date    = (p.created_at || '').slice(0, 10);
    const docs    = (p.docs || []).map(d => `### ${d.filename || 'doc'}\n\n${d.content || ''}`).join('\n\n');
    const prompt  = p.prompt_template ? `## System Prompt\n\n${p.prompt_template}\n\n` : '';
    const desc    = p.description    ? `## Description\n\n${p.description}\n\n`       : '';

    const content = `---\ntype: claude-project\ndate: ${date}\ntitle: "${title.replace(/"/g, '')}"\n---\n\n# ${p.name || title}\n\n${desc}${prompt}${docs}\n`;
    fs.writeFileSync(path.join(VAULT_DIR, 'projects', `${title}.md`), content, 'utf-8');
    count++;
  }
  console.log(`✓ ${count} projects imported`);
}

/* ---------- 4. Re-index ---------- */
async function reindex() {
  console.log('\nReindexing vault…');
  const { indexAll } = require('./indexer');
  await indexAll();
  console.log('✓ Reindex complete');
}

(async () => {
  importMemory();
  importConversations();
  importProjects();
  await reindex();
})();
