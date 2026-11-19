// Product titles for the Staff Room and its workspaces: one rule, so every screen writes staff abbreviations the same way.

/** Staff abbreviations a product file name writes in lower case; the title restores them (coa-decision-brief is "COA decision brief"). */
const STAFF_ACRONYMS: ReadonlySet<string> = new Set([
  'coa', 'coas', 'ecoa', 'ecoas', 'ccir', 'ccirs', 'pir', 'pirs', 'ffir', 'ffirs', 'eefi', 'dsm', 'dst', 'logstat', 'logstats', 'frago', 'fragos', 'warno',
  'opord', 'oplan', 'conops', 'intsum', 'intrep', 'ipb', 'ipoe', 'jipoe', 'roe', 'rfi', 'rfis', 'moe', 'mop', 'hpt', 'hvt', 'nai', 'tai', 'cop', 'cog',
  'isr', 'hss', 'cimic', 'b2c2wg', 'jtf', 'joc', 'tpfdd'
]);

/** A product's title from its file name: hyphens become spaces, the first letter is capital, and staff abbreviations and section codes are upper case. */
export function productTitle(product: string): string {
  const words = product.split('-').filter(Boolean).map((word, index) => {
    if (STAFF_ACRONYMS.has(word)) return word.endsWith('s') && STAFF_ACRONYMS.has(word.slice(0, -1)) ? `${word.slice(0, -1).toUpperCase()}s` : word.toUpperCase();
    if (/^[jgs][1-9]$/.test(word)) return word.toUpperCase();
    if (index > 0 && /^[a-z]$/.test(word)) return word.toUpperCase(); // COA a is COA A
    return word;
  });
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
