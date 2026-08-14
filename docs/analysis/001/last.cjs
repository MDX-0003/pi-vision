const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json', 'utf8'));
const resultsById = new Map();
for (const e of data.entries) {
  if (e.type !== 'message') continue;
  if (e.message.role === 'toolResult' && e.message.toolCallId) {
    resultsById.set(e.message.toolCallId, { entryId: e.id, isError: e.message.isError, content: e.message.content });
  }
}
let seq = 0;
const out = [];
for (const e of data.entries) {
  if (e.type !== 'message' || e.message.role !== 'assistant') continue;
  for (const c of e.message.content || []) {
    if (c.type !== 'toolCall') continue;
    seq++;
    const res = resultsById.get(c.id);
    if (!res || c.name !== 'assess_lighting') continue;
    const text = res.content.map(x => x.text || '').join('\n');
    // find injected ue-harness notes (after JSON) and the analysis array summary
    const lines = text.split('\n');
    const ueNotes = lines.filter(l => l.includes('[ue-harness]'));
    let analysis = '';
    const m = text.match(/"analysis":\s*\[([\s\S]*?)\]/);
    if (m) {
      try {
        const arr = JSON.parse('[' + m[1] + ']');
        analysis = arr.map(a => a.aspect + '=' + a.status + '(T' + a.tier + ')').join(', ');
      } catch { analysis = '(parse fail)'; }
    }
    const overall = (text.match(/"overall":\s*"([^"]+)"/) || [])[1] || '';
    out.push('[' + seq + '] assess: ' + analysis);
    out.push('  overall: ' + overall.slice(0, 200));
    if (ueNotes.length) out.push('  UE-NOTES: ' + ueNotes.join(' | '));
  }
}
fs.writeFileSync('F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/assess-summary.txt', out.join('\n'), 'utf8');
console.log(out.join('\n'));
