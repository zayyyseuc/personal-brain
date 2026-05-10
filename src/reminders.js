const fs   = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/reminders.json');

function load() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return []; }
}

function save(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function add({ content, remind }) {
  const list = load();
  const id   = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const item = {
    id,
    content: content.trim(),
    remind:  remind || todayStr(),
    status:  'active',
    created: todayStr(),
  };
  list.push(item);
  save(list);
  return item;
}

function listDue() {
  const today = todayStr();
  return load().filter(r => r.status === 'active' && r.remind <= today);
}

function update(id, { status, remind }) {
  const list = load();
  const item = list.find(r => r.id === id);
  if (!item) { const err = new Error('提醒不存在'); err.status = 404; throw err; }
  if (status !== undefined) item.status = status;
  if (remind !== undefined) item.remind = remind;
  save(list);
  return item;
}

function remove(id) {
  const list = load();
  const next = list.filter(r => r.id !== id);
  if (next.length === list.length) { const err = new Error('提醒不存在'); err.status = 404; throw err; }
  save(next);
}

module.exports = { add, listDue, update, remove };
