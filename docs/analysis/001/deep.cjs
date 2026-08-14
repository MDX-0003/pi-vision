const fs = require('fs');
const SRC = 'C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json';
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const out = [];
const resultsById = new Map();
for (const e of data.entries) {
  if (e.type !== 'message') continue;
  if (e.message.role === 'toolResult' && e.message.toolCallId) {
    resultsById.set(e.message.toolCallId, { entryId: e.id, ts: e.timestamp, isError: e.message.isError, content: e.message.content });
  }
}
function textOf(res) { return res.content.map(x => x.text || '').join('\n'); }

// 1. assistant messages of interest
const interesting = new Set(['77820c90','2a21591a','48314cbc','6131229b','9cafbca3','20c0dd6f','59058a03','4d5a06e7','d3a44186','109c1220','5b814965','c80ca6e4','1af99fc8','fd966e37','4ba82a50']);
for (const e of data.entries) {
  if (e.type !== 'message' || e.message.role !== 'assistant') continue;
  if (!interesting.has(e.id)) continue;
  const texts = e.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  out.push('\n========== ASSISTANT ' + e.id + ' (ts=' + e.timestamp + ', stop=' + e.message.stopReason + ') ==========');
  out.push(texts);
}

// 2. full assess texts for calls with parse failures (17, 30) 鈥?find by args + name
let seq = 0;
for (const e of data.entries) {
  if (e.type !== 'message' || e.message.role !== 'assistant') continue;
  for (const c of e.message.content || []) {
    if (c.type !== 'toolCall') continue;
    seq++;
    const res = resultsById.get(c.id);
    if (!res) continue;
    if ((seq === 17 || seq === 30) && c.name === 'assess_lighting') {
      out.push('\n========== ASSESS FULL TEXT [' + seq + '] ==========');
      out.push(textOf(res));
    }
    if (c.name === 'toolset_registry_toolsets_core_programmatic_ProgrammaticToolset_execute_tool_script') {
      out.push('\n========== EXECUTE_TOOL_SCRIPT [' + seq + '] ==========');
      out.push('ARGS: ' + JSON.stringify(c.arguments));
      out.push('RESULT: ' + textOf(res).slice(0, 800));
    }
  }
}
fs.writeFileSync('F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/deep.txt', out.join('\n'), 'utf8');
console.log('written deep.txt, length', out.join('\n').length);
