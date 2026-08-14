const fs = require('fs');
const SRC = 'C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json';
const OUT = 'F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/timeline.txt';
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const lines = [];
const resultsById = new Map();
for (const e of data.entries) {
  if (e.type !== 'message') continue;
  for (const c of e.message.content || []) {
    if (c.type === 'toolResult') resultsById.set(c.toolCallId, { entryId: e.id, ...c });
  }
  if (e.message.role === 'toolResult' && e.message.toolCallId) {
    resultsById.set(e.message.toolCallId, { entryId: e.id, toolName: e.message.toolName, isError: e.message.isError, content: e.message.content, details: e.message.details });
  }
}
function textOf(res) {
  if (!res) return '(none)';
  const parts = [];
  for (const c of res.content || []) {
    if (c.type === 'text') parts.push(c.text || '');
    else if (c.type === 'image') parts.push('[IMAGE ' + (c.mediaType || '?') + ' ' + (c.bytes || (c.data ? c.data.length : '?')) + ' bytes]');
    else parts.push('[' + c.type + ']');
  }
  return parts.join('\n');
}
let seq = 0;
for (const e of data.entries) {
  if (e.type !== 'message') {
    lines.push('== ' + e.type + ' ' + e.id + ' ' + (e.timestamp || ''));
    continue;
  }
  const m = e.message;
  if (m.role === 'assistant') {
    const texts = m.content.filter(c => c.type === 'text').map(c => (c.text || '').trim()).filter(Boolean);
    const tcs = m.content.filter(c => c.type === 'toolCall');
    if (tcs.length === 0 && texts.length === 0) continue;
    if (texts.length) lines.push('\n--- [' + seq + '] ASSISTANT(' + e.id + ') ' + (m.model || '') + ' stop=' + m.stopReason + ' ts=' + e.timestamp + ':\n' + texts.join('\n').slice(0, 2200));
    for (const tc of tcs) {
      seq++;
      const res = resultsById.get(tc.id);
      lines.push('\n### [' + seq + '] TOOLCALL ' + tc.name + ' id=' + tc.id + ' ts=' + (res ? res.entryId : '?') + ' args=' + JSON.stringify(tc.arguments).slice(0, 900));
      if (res) {
        const t = textOf(res).slice(0, 1600);
        lines.push('  RESULT isError=' + res.isError + ' details=' + (res.details ? JSON.stringify(res.details).slice(0,300) : 'null') + ' text=' + t);
      } else {
        lines.push('  RESULT: NOT FOUND');
      }
    }
  } else if (m.role === 'user') {
    const texts = m.content.filter(c => c.type === 'text').map(c => (c.text || '').trim()).filter(Boolean);
    if (texts.length) lines.push('\n--- USER(' + e.id + '): ' + texts.join('\n').slice(0, 400));
  }
}
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('Wrote ' + OUT + ' lines: ' + lines.length + ' seq=' + seq);
