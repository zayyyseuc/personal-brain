const https = require('https');
require('dotenv').config();

async function tavilySearch(query) {
  const body = JSON.stringify({
    api_key: process.env.TAVILY_API_KEY,
    query,
    search_depth: 'basic',
    max_results: 3,
    include_answer: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('tavily timeout')); });
    req.write(body);
    req.end();
  });
}

// Returns { context: string, webSources: [{title, url}] } or null on failure
async function fetchWebContext(query) {
  try {
    const data = await tavilySearch(query);
    const results = data.results || [];
    if (results.length === 0) return null;

    const context = results
      .map((r, i) => `[网络${i + 1}] ${r.title}\n${r.content}`)
      .join('\n\n');

    const webSources = results.map(r => ({ type: 'web', title: r.title, url: r.url }));
    return { context, webSources };
  } catch (err) {
    console.error('[web-search] 搜索失败:', err.message);
    return null;
  }
}

module.exports = { fetchWebContext };
