const fs = require('fs');
const SRC = 'C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json';
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const out = [];
const resultsById = new Map();
for (const e of data.entries) {
  if (e.type !== 'message') continue;
  if (e.message.role === 'toolResult' && e.message.toolCallId) {
    resultsById.set(e.message.toolCallId, { entryId: e.id, ts: e.timestamp, toolName: e.message.toolName, isError: e.message.isError, content: e.message.content, details: e.message.details });
  }
}
function textOf(res) {
  const parts = [];
  for (const c of res.content || []) {
    if (c.type === 'text') parts.push(c.text || '');
    else if (c.type === 'image') parts.push('[IMAGE ' + (c.bytes || (c.data ? c.data.length : '?')) + 'B]');
    else parts.push('[' + c.type + ']');
  }
  return parts.join('\n');
}
let seq = 0;
const toolStats = {};
for (const e of data.entries) {
  if (e.type !== 'message' || e.message.role !== 'assistant') continue;
  for (const c of e.message.content || []) {
    if (c.type !== 'toolCall') continue;
    seq++;
    const res = resultsById.get(c.id);
    const err = res ? res.isError : null;
    toolStats[c.name] = toolStats[c.name] || { total: 0, err: 0 };
    toolStats[c.name].total++;
    if (err) toolStats[c.name].err++;
    const t = res ? textOf(res) : '(no result)';
    let summary = t;
    if (c.name === 'assess_lighting') {
      try {
        const j = JSON.parse(t);
        summary = 'luminance.deltaPct=' + (j.quantitative?.luminance?.deltaPct) + ' deltaE.mean=' + (j.quantitative?.deltaE?.mean) + ' chroma.diff=' + (j.quantitative?.chroma?.diff) + ' overall=' + JSON.stringify(j.overall).slice(0,200);
      } catch { summary = 'PARSE_FAIL ' + t.slice(0,200); }
    }
    out.push('[' + seq + '] ' + c.name + (err === null ? ' [NO-RESULT]' : err ? ' [ERROR]' : ' [ok]') + ' args=' + JSON.stringify(c.arguments).slice(0, 500));
    out.push('   -> ' + summary.slice(0, 700).replace(/\n/g, ' '));
  }
}
fs.writeFileSync('F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/summary.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
console.log('\n=== TOOL STATS ===');
console.log(JSON.stringify(toolStats, null, 1));
