import vm from 'node:vm';
import fs from 'node:fs';
const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  try {
    new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f });
    console.log('OK', f);
  } catch (e) {
    bad++;
    console.log('SYNTAX-ERROR', f, e.message);
  }
}
process.exit(bad ? 1 : 0);
