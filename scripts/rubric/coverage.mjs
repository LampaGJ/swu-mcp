// @pocTriage: becomes the coverage report / unclassified-flag step of the committed #322 SWU scoring script
// Share of ability sentences on JTL+ cards that the deterministic EFFECTS regexes classify.
// A sentence counts as classified when any EFFECTS pattern matches it, or it is a pure keyword
// line, or a pure restriction ("Attach to ..."), or a deploy/epic boilerplate line.
import { readFileSync, writeFileSync } from 'node:fs';
import { EFFECTS, clean } from './features.mjs';

const DIR = decodeURIComponent(new URL('../../data/rubric/', import.meta.url).pathname);
const cards = JSON.parse(readFileSync(DIR + 'cards.json', 'utf8')).filter((c) => c.jtlPlus);
const KWLINE = /^(?:(?:Sentinel|Restore \d+|Ambush|Raid \d+|Overwhelm|Saboteur|Hidden|Shielded|Grit|Support|Exploit \d+|Plot|Coordinate|Fortify|Smuggle \[[^\]]*\]|Piloting \[[^\]]*\]|Bounty)[ ,]*)+$/;
const BOILER = /^(?:Epic Action: If you control \d+ or more resources, deploy this leader\.?|Deploy this leader\.?)$/i;
const fields = { text: (c) => c.text, deployBox: (c) => c.deployBox, epicAction: (c) => c.epicAction };
const res = {};
const unclassifiedCards = new Map();
for (const c of cards) {
  for (const [fname, get] of Object.entries(fields)) {
    const sentences = clean(get(c)).split(/\n+|(?<=\.)\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => s && !/^[.\s]*$/.test(s));
    for (const s of sentences) {
      const key = `${c.type}:${fname}`;
      res[key] ??= { sentences: 0, classified: 0, keywordOnly: 0, boiler: 0 };
      res[key].sentences++;
      if (KWLINE.test(s)) { res[key].keywordOnly++; res[key].classified++; continue; }
      if (BOILER.test(s)) { res[key].boiler++; res[key].classified++; continue; }
      const hit = Object.values(EFFECTS).some(({ re }) => re.test(s));
      if (hit) res[key].classified++;
      else unclassifiedCards.set(c.serialCode, (unclassifiedCards.get(c.serialCode) ?? 0) + 1);
    }
  }
}
let S = 0, C = 0, Sx = 0, Cx = 0;
for (const [k, v] of Object.entries(res).sort()) {
  S += v.sentences; C += v.classified;
  Sx += v.sentences - v.keywordOnly - v.boiler; Cx += v.classified - v.keywordOnly - v.boiler;
  console.log(`${k.padEnd(22)} sentences=${v.sentences} classified=${v.classified} (${(100 * v.classified / v.sentences).toFixed(1)}%) keywordOnly=${v.keywordOnly} boiler=${v.boiler}`);
}
console.log(`ALL JTL+: ${C}/${S} = ${(100 * C / S).toFixed(1)}% classified; excluding pure keyword and deploy boilerplate lines: ${Cx}/${Sx} = ${(100 * Cx / Sx).toFixed(1)}%`);
console.log(`cards with >=1 unclassified sentence: ${unclassifiedCards.size} of ${cards.length}`);
writeFileSync(DIR + 'coverage.out.json', JSON.stringify({ script: 'coverage.mjs', perField: res, total: { sentences: S, classified: C }, abilityOnly: { sentences: Sx, classified: Cx }, cardsWithUnclassified: unclassifiedCards.size, cards: cards.length }, null, 1));
