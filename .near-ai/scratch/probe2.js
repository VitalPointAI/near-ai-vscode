const { plainDownload } = require('../../dist/domain/plainDownload.js');
const cases = [
  ['-sS','--max-time','25','-o','/dev/null','-w','code=%{http_code}','https://example.test/p'],
  ['-sS','--connect-timeout','5','-o','/dev/null','https://example.test/x'],
  ['-q','--tries','3','-O','/dev/null','https://example.test/x'],
  ['-q','-T','30','-O','/dev/null','https://example.test/x'],
];
for (const c of cases) console.log(c.join(' '), '=>', JSON.stringify(plainDownload(c, c[0] === '-q' ? 'wget' : 'curl')));
