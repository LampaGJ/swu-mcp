// @pocTriage: becomes the deterministic feature-extraction step of the committed #322 SWU scoring script
// Deterministic regex feature extraction over SWU card text. Every pattern is listed in
// EFFECTS / TIMINGS / KEYWORD_PARAMS so the rubric doc can quote them verbatim.

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
export const num = (s) => (s == null ? 1 : /^\d+$/.test(s) ? +s : NUM[s.toLowerCase()] ?? 1);

// Reminder text is parenthesised; strip it so "(... deal 1 damage ...)" in a keyword
// reminder does not count as an effect. Non-breaking hyphens normalised.
export const clean = (t) => (t ?? '').replace(/[‑–−]/g, '-').replace(/^Attach to [^.\n]*\.\s*/gm, '').replace(/\([^)]*\)/g, ' ').replace(/[ \t]+/g, ' ');

const UNIT = '(?:(?:an?|another|each|up to \\w+|\\d+|that|the|this|target)\\s+)?(?:[\\w-]+\\s+){0,4}?units?';

// name -> { re, mag?: (match) => magnitude }. Magnitude defaults to 1 per card when matched.
export const EFFECTS = {
  dmgUnit: { re: new RegExp(`deal (\\d+|X) damage to ${UNIT}`, 'i'), mag: (m) => (m[1] === 'X' ? 3 : +m[1]) },
  dmgVariable: { re: /deals? damage (?:to [\w ]+ )?equal to|deal damage to (?:a|an|another) [\w ]*?unit equal to/i },
  taxOpponent: { re: /(?:an opponent|enemy|opponents?) [\w ]*?costs? \[?\d+ resources?\]? more/i },
  dmgEach: { re: /deal (\d+) damage to each/i, mag: (m) => +m[1] },
  dmgBase: { re: /deal (\d+) (?:indirect )?damage to (?:a|each|the|an enemy|your opponent's|their|that) (?:base|defending player|player|opponent)/i, mag: (m) => +m[1] },
  upgradeRemoval: { re: /defeat (?:an?|each|that|up to \w+) (?:[\w-]+ ){0,2}?upgrades?/i },
  recursion: { re: /(?:from your discard pile (?:to|into) your hand|return (?:a|an|that) [^.]*? from your discard pile)/i },
  smoothing: { re: /look at the top (\d+|X) cards?/i },
  defeatUnit: { re: new RegExp(`defeat ${UNIT}(?! token)`, 'i') },
  bounce: { re: /return (?:an?|another|each|that|up to \w+) (?:[\w-]+ ){0,4}?(?:unit|upgrade|card)s? (?:[\w ]+ )?to (?:its|their) owner's hand/i },
  capture: { re: /\bcaptures?\b/i },
  takeControl: { re: /take control of/i },
  debuff: { re: /gets? -(\d+)\/-(\d+)/i, mag: (m) => +m[1] + +m[2] },
  draw: { re: /\bdraws? (a|an|one|two|three|\d+) cards?/i, mag: (m) => num(m[1]) },
  search: { re: /search the top (\d+|X) cards?/i, mag: (m) => (m[1] === 'X' ? 5 : +m[1]) },
  discardOpp: { re: /(?:(?:opponent|each player|they) discards?|discard (?:a|an|\d+) [\w ]*?from (?:it|their hand|an opponent's hand))/i },
  heal: { re: /heal (\d+|all|up to \d+) damage/i, mag: (m) => (/all/.test(m[1]) ? 5 : +m[1].replace(/\D/g, '')) },
  exhaust: { re: new RegExp(`exhaust ${UNIT}`, 'i') },
  ready: { re: /\bready (?:an?|another|each|that|this|up to \w+|a friendly) (?:[\w-]+ ){0,3}?(?:unit|resource|leader)/i },
  extraAttack: { re: /attack with (?:a|an|another|that|up to \w+) (?:[\w-]+ ){0,3}?units?/i },
  buffTemp: { re: /(?:gets?|give (?:a|an|another|each) (?:[\w-]+ ){0,3}?units?) \+(\d+)\/\+(\d+) for this (?:phase|attack)/i, mag: (m) => +m[1] + +m[2] },
  buffStatic: { re: /gets? \+(\d+)\/\+(\d+)(?! for this)/i, mag: (m) => +m[1] + +m[2] },
  giveShield: { re: /give (a|an|\d+|two|three) Shield tokens?/i, mag: (m) => num(m[1]) },
  giveExperience: { re: /give (a|an|\d+|two|three|X) Experience tokens?/i, mag: (m) => (m[1] === 'X' ? 2 : num(m[1])) },
  giveAdvantage: { re: /give (a|an|\d+|two|three|X) Advantage tokens?/i, mag: (m) => (m[1] === 'X' ? 2 : num(m[1])) },
  giveWeakness: { re: /give (a|an|\d+|two|three|X) Weakness tokens?/i, mag: (m) => (m[1] === 'X' ? 2 : num(m[1])) },
  tokenUnit: { re: /create (a|an|\d+|two|three|X) (Battle Droid|Clone Trooper|TIE Fighter|X-Wing|Spy|Mandalorian|Beast) tokens?/i, mag: (m) => num(m[1]) * ({ 'battle droid': 2, 'clone trooper': 4, 'tie fighter': 2, 'x-wing': 4, spy: 2, mandalorian: 5, beast: 6 }[m[2].toLowerCase()] ?? 2) },
  credit: { re: /create (a|an|\d+|two|three|X) Credit tokens?/i, mag: (m) => num(m[1]) },
  forceGain: { re: /(?:the Force is with you|create (?:a|the) Force token|you gain the Force)/i },
  forceUse: { re: /use the Force/i },
  ramp: { re: /(?:into play as a resource|put (?:the top card of your deck|a card from your hand) .*?as a resource|gain (?:a|\d+) resources?)/i },
  costReduce: { re: /(?:costs? (\d+) (?:resources? )?less|pay (\d+) (?:resources? )?less|ignore (?:its|the|their) aspect penalt)/i },
  playFromElsewhere: { re: /play (?:a|an|that|it|the) (?:[\w-]+ ){0,4}?(?:from your discard pile|from (?:the top of )?your deck|from your resources)|for free/i },
  protect: { re: /(?:can't be attacked|can't be (?:defeated|damaged)|prevent (?:all|that|the|\d+) damage)/i },
  grantKeyword: { re: /(?:(?:units?|it|they) gains? (?:Sentinel|Ambush|Raid|Overwhelm|Saboteur|Restore|Grit|Hidden|Shielded)|gains? (?:Sentinel|Ambush|Raid|Overwhelm|Saboteur|Restore|Grit|Hidden|Shielded) for|give (?:a|an|another|each) (?:[\w-]+ ){0,3}?units? (?:Sentinel|Ambush|Raid \d+|Overwhelm|Saboteur|Restore \d+|Grit|Hidden|Shielded))/i },
  selfKeywordConditional: { re: /(?:this unit|she|he|it) gains? (?:Sentinel|Ambush|Raid \d+|Overwhelm|Saboteur|Restore \d+|Grit|Hidden|Shielded)/i },
  // Drawbacks: things the card does against its owner.
  drawback: { re: /(?:this unit can't (?:attack|ready)|can't attack bases|enters play exhausted|deal \d+ damage to (?:your|your own|this|friendly) (?:base|unit)|defeat a friendly|return a friendly|discard (?:a|\d+) cards? from your hand|you lose|opponent (?:draws|creates|may)|give (?:your opponent|an opponent) )/i },
};

// Timing of each ability line, from its printed prefix.
export const TIMINGS = {
  whenPlayed: /^(?:When Played(?: as a unit| as an upgrade)?|When played using Smuggle)(?:\/On Attack)?:/i,
  onAttack: /^(?:When Played\/)?On Attack:/i,
  whenDefeated: /^When Defeated:/i,
  action: /^(?:Epic )?Action ?(?:\[[^\]]*\])?:/i,
  whenAttackEnds: /^When Attack Ends:/i,
  triggered: /^(?:When|Whenever|After|The first time|Each time)\b/i,
  constant: /^(?:While|Each|Friendly|Enemy|Other|This unit|Units|You may|Attached)/i,
};

// Keyword name -> parameter regex (numeric N or bracketed cost); null when the keyword has no parameter.
export const KEYWORD_PARAMS = {
  Raid: /\bRaid (\d+)/,
  Restore: /\bRestore (\d+)/,
  Exploit: /\bExploit (\d+)/,
  Smuggle: /\bSmuggle \[(\d+)/,
  Piloting: /\bPiloting \[(\d+)/,
};

// A keyword is "printed" when an ability line starts with it; otherwise it is granted conditionally
// ("While the Force is with you, this unit gains Sentinel").
export function keywordFeatures(card) {
  const lines = clean(card.text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out = {};
  for (const k of card.keywords) {
    const printed = lines.some((l) => l.startsWith(k));
    const pre = KEYWORD_PARAMS[k];
    const m = pre ? (card.text ?? '').match(pre) : null;
    out[k] = { printed, n: m ? +m[1] : 1 };
  }
  return out;
}

export function effectFeatures(text) {
  const lines = clean(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const eff = {}, timing = {};
  let matchedLines = 0, abilityLines = 0;
  const KW = /^(?:Sentinel|Restore \d+|Ambush|Raid \d+|Overwhelm|Saboteur|Hidden|Shielded|Grit|Support|Exploit \d+|Plot|Coordinate|Fortify|Smuggle \[[^\]]*\]|Piloting \[[^\]]*\]|Bounty)\s*(?:—|-)?\s*/;
  for (const raw of lines) {
    const l = raw.replace(KW, '').replace(KW, '').trim();
    if (!l) continue;
    abilityLines++;
    let t = Object.keys(TIMINGS).find((k) => TIMINGS[k].test(l)) ?? 'constant';
    if (TIMINGS.whenPlayed.test(l) && TIMINGS.onAttack.test(l.replace(/^When Played\//i, ''))) t = 'whenPlayedOnAttack';
    let hit = false;
    for (const [name, { re, mag }] of Object.entries(EFFECTS)) {
      const m = l.match(re);
      if (!m) continue;
      hit = true;
      const v = mag ? mag(m) : 1;
      eff[name] = (eff[name] ?? 0) + (Number.isFinite(v) ? v : 1);
      timing[`${name}@${t}`] = 1;
    }
    if (hit) matchedLines++;
    timing[`t:${t}`] = (timing[`t:${t}`] ?? 0) + 1;
  }
  return { eff, timing, abilityLines, matchedLines };
}
