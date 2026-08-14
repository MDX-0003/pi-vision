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
// 1. all results whose text contains error markers or isError true
let seq = 0;
for (const e of data.entries) {
  if (e.type !== 'message' || e.message.role !== 'assistant') continue;
  for (const c of e.message.content || []) {
    if (c.type !== 'toolCall') continue;
    seq++;
    const res = resultsById.get(c.id);
    if (!res) continue;
    const text = res.content.map(x => x.text || '').join('\n');
    const flagged = res.isError || /server_error|unknown|error|Error|exception|not valid|Connection|failed|blocked|guard|denied/i.test(text);
    if (flagged) {
      out.push('[' + seq + '] ' + c.name + ' isError=' + res.isError + ' entry=' + res.entryId);
      out.push('  ARGS: ' + JSON.stringify(c.arguments).slice(0, 900));
      out.push('  TEXT: ' + text.slice(0, 2500));
      out.push('  DETAILS: ' + JSON.stringify(res.details).slice(0, 500));
      out.push('---');
    }
  }
}
out.push('\n===== SYSTEM PROMPT =====');
out.push(data.systemPrompt || '(none)');
fs.writeFileSync('F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/details.txt', out.join('\n'), 'utf8');
console.log('flagged results:', (out.join('\n').match(/^\[\d+\]/gm) || []).length);
console.log('written details.txt');
