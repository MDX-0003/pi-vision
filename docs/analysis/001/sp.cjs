const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/pi-session-2026-08-14.json', 'utf8'));
const sp = data.systemPrompt || '';
fs.writeFileSync('F:/GitProj/Pi-Learn/pi-vision/docs/analysis/001/systemprompt.txt', sp, 'utf8');
console.log('systemPrompt length:', sp.length);
// find injected section markers
const markers = ['PHASE', 'phase', 'Tier', 'tier', '鍋滄粸', '鍥炴粴', 'ROLLBACK', 'stall', 'regression', '鏀舵暃', 'SETUP', 'TUNING', 'POSTPROCESS', 'FINAL', 'DONE', '杞?, 'round', 'best', 'guard', 'Guard', 'GUARD'];
for (const m of markers) {
  const idxs = [];
  let i = sp.indexOf(m);
  while (i !== -1 && idxs.length < 6) { idxs.push(i); i = sp.indexOf(m, i + 1); }
  if (idxs.length) console.log(m, '->', idxs.join(','));
}
// print the tail of systemPrompt (injected section usually at end)
console.log('==== TAIL 3500 ====');
console.log(sp.slice(-3500));
