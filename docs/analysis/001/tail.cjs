const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json', 'utf8'));
console.log('HEADER:', JSON.stringify(data.header, null, 1));
console.log('leafId:', data.leafId);
// full entry list: id, type, role, ts, first text snippet
for (const e of data.entries) {
  let info = e.type;
  if (e.type === 'message') {
    const role = e.message.role;
    let snippet = '';
    for (const c of e.message.content || []) {
      if (c.type === 'text') { snippet = (c.text || '').replace(/\n/g, ' ').slice(0, 90); break; }
      if (c.type === 'toolCall') { snippet = 'TOOLCALL ' + c.name; break; }
      if (c.type === 'image') { snippet = '[image]'; break; }
    }
    info = role + ' | ' + snippet + (e.message.isError !== undefined ? ' | isError=' + e.message.isError : '');
  }
  console.log(e.id + ' ' + e.timestamp + ' ' + info);
}
