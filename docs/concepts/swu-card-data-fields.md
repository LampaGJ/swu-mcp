---
type: concept
status: active
related: [https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md]
---

# SWU card and price data: field guide

TL;DR: mault exports two kinds of Star Wars: Unlimited (SWU) data. The first is the official card list from api.starwarsunlimited.com, one record per printing (a "printing" is one specific version of a card, such as Standard, Hyperspace or Showcase). The second is the conformed TCGplayer price list, which attaches a normal and foil price to those printings and records every correction and rejection made on the way. The two join on `serialCode` (official) = `card_id` (price). This page explains every field: what it is, what you can decide with it, and which rules it combines with. The machine-readable twin is [swu-card-data.schema.json](swu-card-data.schema.json), and every facet value (aspect, trait, keyword, type, arena, rarity, expansion, variant, token) has a plain-language entry in [swu-glossary.json](swu-glossary.json). The untouched API pages are documented in the section "Raw API page". The field inventory behind this page was generated mechanically from the exported files, so no key is missing.

Card images are out of scope. The data carries an `artFront` image-metadata subtree (and the code allows an `artBack`), but both are deliberately not documented here or described in the schema.

Conventions:
- Paths use `[]` for "each item of an array". Price files and the official list both start with `printings[]`; the section heading says which one a path belongs to.
- "(inferred)" means the meaning was read from the data, not from code or the rules digest.
- "Rules digest" means `/Volumes/Local Files/Projects/swu/complete_rules_digest.md`. Where it is silent, this page says so.
- Code citations are `path:line`, relative to the repo root.

## The files

- Official card list, `official-card-list-import-43.json`: `{ printings: [...] }`, 10,211 printings. Keeps only the fields conformance reads: `serialCode`, `cardNumber`, `title`, `subtitle`, `cost`, `power`, `hp`, `type`, `rarity`, `aspects`, `expansion`, `variantTypes` ([`packages/server/src/lib/adapters/swu/conform/snapshot-types.ts:12`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/server/src/lib/adapters/swu/conform/snapshot-types.ts#L12)).
- Catalogue snapshots, four older files: same shape, differing field subsets, 10,193 printings each. Counts in this guide say which population they cover: the 10,246-printing raw card list of 2026-10-16, or the 10,193-printing snapshots. The hp, rulesStyled and variantId counts are recomputed from the raw card list by `scripts/glossary/field-guide-counts.ts` in swu-mcp (`pnpm exec tsx scripts/glossary/field-guide-counts.ts`). Details per field below and in "Which snapshot has which field".
- Price export, `tcgplayer-prices-rectified-import-43.json`: `{ import: {...}, printings: [...] }`. 8,882 `tcg_printings` rows plus the one `price_imports` row.
- Corrections, `corrections-import-43.json`: array of `tcg_corrections` rows (1,038).
- Quarantine, `quarantine-import-43.json`: array of `tcg_quarantine` rows (122).

Official data comes as a Strapi API response (Strapi is the content system behind the official site). Every relation (type, rarity, aspects, ...) is wrapped as `{ data: { attributes: { name } } }`, and every many-valued relation as `{ data: [ { attributes: { name } } ] }`. mault trims each relation to its names ([`packages/server/src/lib/adapters/swu/api-types.ts:11-37`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/server/src/lib/adapters/swu/api-types.ts#L11-L37)).

## Printing

One record per printing. A card the game treats as "the same card" can have dozens of printings, each with its own `serialCode`, art and price. `PlayingCard.id` is deliberately per printing for this reason (`CLAUDE.md`, Multi-TCG section).

### Identity fields

- **`printings[].serialCode`**
  - Type: string. Example: `"0101001"`, `"c25080001"`, `"ts260100t2"`. Present in every file; 7 to 10 characters; unique per record.
  - Meaning: the printing's unique id, and mault's `cards.card_id`. Characters 3 and 4 are the variant-type digits: `08010232` is set 08, type 01 (Standard), number 0232 ([`packages/server/src/lib/adapters/swu/variant-kind.ts:3-7`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/server/src/lib/adapters/swu/variant-kind.ts#L3-L7)). Promo serials start with a lowercase letter code (`p26780050`, `c25080001`, `gg320001`), and the digit position then shifts (variant-kind.ts:5-6).
  - **Strategic value**: the join key to price data and to a scanned card. A collector or the sorter decides "which exact printing is this" with it.
  - **Interacts with**: equals `tcg_printings.card_id` in the price export. Its variant digits must agree with `variantTypes` (see `swuPrintingVariant`, variant-kind.ts:59-66). Same-title cards across sets have different serials.
- **`printings[].cardNumber`**
  - Type: integer. Example: `1`, `65`, `1062`. 1,167 distinct values in the official list.
  - Meaning: the collector number inside its expansion, as the official API gives it. It can differ from the number in the serial (the Red Leader case: official 1062, serial 1063, `conform/rules.ts:111`).
  - **Strategic value**: finds a card in a binder or set list; distinguishes a printing from its Showcase or Hyperspace twin only together with the variant.
  - **Interacts with**: TCGplayer lists a "Number" per product; the classifier matches it to `cardNumber` within an expansion and variant pool, and `number-shift` corrections move it by one (`conform/rules.ts:202-206`).
- **`printings[].title`**
  - Type: string. Example: `"Luke Skywalker"`. 2,060 distinct titles in the official list.
  - Meaning: the card's name. The rules digest says a card's name is its title; the subtitle has no mechanical function (digest section 2, "Subtitle").
  - **Strategic value**: what players say aloud and what deck lists show.
  - **Interacts with**: with `subtitle` it forms the card's identity (unique leaders share a title across versions). Suspension and legality matching uses the normalised title plus subtitle ([`docs/concepts/swu-formats.md`](https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md), "Matching rule"). TCGplayer title typos are fixed by the `title-drift` rule (`conform/rules.ts:197-199`).
- **`printings[].subtitle`**
  - Type: string or null. Example: `"Championing Her People"`, `""`, `null`. In the official list 5,084 are the empty string and 706 are null (a Base has `null`).
  - Meaning: the second line of the name. Digest: "no mechanical function"; but the digest's Unique rule says the subtitle differentiates versions of a unique card (section 8.30).
  - **Strategic value**: tells two versions of the same character apart (a leader versus a unit version). Matters for the Unique rule: you may control only one copy per player (section 8.30).
  - **Interacts with**: `title` for identity; the `unique` icon (not in the export).
- **`printings[].artist`** (snapshots only)
  - Type: string. Example: `"Johnny Morrow"`. 199 distinct. Required in the code (`api-types.ts:120`).
  - Meaning: the credited illustrator, printed on the card's credit line (digest section 2, item 13).
  - **Strategic value**: collectors chase artists; a signed or alter piece is valued by it.
  - **Interacts with**: nothing in the rules. It is also a sentinel: a stored row without `artist` is the old partial shape and triggers a fallback (`api-types.ts:155-160`).

### Rules-text fields (snapshots only)

- **`printings[].text`** (snapshots abba1a4e and a9fa9369 and aa0e0918 and 69ceeab2: all four carry it)
  - Type: string or null. Example: `"Each friendly damaged unit gets +1/+0. "`. Empty string on 541 printings; null on 64 (bases with no text, such as Capital City Base).
  - Meaning: the card's rules text box. Keyword reminder text sits in brackets. Paragraphs are separated by `\n\n`.
  - **Strategic value**: what the card does; the field a deck builder searches. Lets you find every card that mentions a trait or keyword.
  - **Interacts with**: `keywords` (the keywords usually appear as the first words of this text), `traits` (other cards' text targets traits, such as "a Republic card"), `type` (Events resolve their text once, then go to the discard pile: digest 3.3), `cost` and `aspects` (what it takes to play).
- **`printings[].deployBox`** (snapshot abba1a4e and a9fa9369)
  - Type: string or null. Example: `"On Attack: You may give another unit a Shield token. "`. Non-null on 513 printings, all Leaders.
  - Meaning: the text on a Leader's back (the Leader Unit side), which applies after the leader deploys (digest 3.4: leaders are double-sided).
  - **Strategic value**: shows what the deployed leader unit does, so you can judge whether reaching the deploy threshold is worth it.
  - **Interacts with**: `epicAction` (the deploy condition), `power` and `hp` (the unit side's stats), and `keywords` (a deployed leader can have Restore, Saboteur and so on).
- **`printings[].epicAction`** (snapshot abba1a4e and a9fa9369)
  - Type: string or null. Example: `"Epic Action: If you control 5 or more resources, deploy this leader."`. Empty string 6,578 times, null 2,917, non-empty on 510 Leaders and 188 Units.
  - Meaning: the once-per-game Epic Action ability. Digest 7.2: "Epic Action: Once per game only", marked by an epic action counter (digest 1.12). On a Leader it is the deploy trigger. The 188 Units that carry non-empty text are Pilot units (their text begins with "Piloting [...]") (inferred).
  - **Strategic value**: tells you when a leader can flip into a unit; a leader that deploys at 4 resources is faster than one that needs 6.
  - **Interacts with**: resources in play (the zone the threshold counts), `deployBox`, `cost` (a deployed leader is not played, so cost is not paid).

### Numbers

- **`printings[].cost`**
  - Type: integer or null. Example: `2`. Values 0 to 15 (all of 0, 1, 2, ..., 12, 14, 15 occur); null on 268 official printings.
  - Meaning: the resources you exhaust to play the card (the yellow box, digest 1.8). Null for Bases, Credit and Force tokens, and 3 Leaders (the last is data as given; meaning inferred: tokens and bases are not played from hand).
  - **Strategic value**: sets your curve. Players count how many cheap cards a deck holds.
  - **Interacts with**: resources per turn (you resource one card each regroup, digest 5.5); the aspect penalty adds 2 per icon the leader and base do not provide (digest 1.5.6, 8.1); `Exploit X` and `Smuggle` change the effective cost (digest 7.5). TCGplayer drift on cost is counted in `byDriftField.cost`.
- **`printings[].power`**
  - Type: integer or null. Values 0 to 15; null on 2,649 official printings (Bases, Events, Upgrades, tokens, some Leaders).
  - Meaning: damage dealt in combat (red box); only units have power (digest 1.10). Upgrades are null here although they carry a modifier on the card (inferred: the API does not give the modifier in this field).
  - **Strategic value**: trade math: who survives an attack.
  - **Interacts with**: `hp`; `Raid X` adds power while attacking; `Grit` adds power per damage; `Overwhelm` sends excess damage to the base (digest 7.5). TCGplayer sometimes lists wrong power; the classifier records the difference as drift (`conform/rules.ts:49`).
- **`printings[].hp`**
  - Type: integer or null. Values 0 to 35. In the 2026-10-16 raw card list (10,246 printings) it is null on 2,393: Events 1,698, Upgrades 667, Token Upgrades 20, Leaders 3, Credit Tokens 3 and Force Tokens 2. It is 30 on 140 printings, all of them Bases.
  - Meaning: hit points (blue box). Units and Bases have HP; a card is defeated when damage reaches HP (digest 1.11, 1.5.5).
  - **Strategic value**: survival and race math: a Base with 30 HP gives a slower clock than one with 25.
  - **Interacts with**: `power` of attackers; `Shielded` and Shield tokens (a Shield prevents one instance of damage, digest 6.3); `Restore X` heals the Base. TCGplayer hp drift is by far the most common (767 of the 863 drifted listings in import 43).

### Relations

Each of the following is a Strapi relation. Structure paths are listed once per relation, then the field that matters.

- **`printings[].type`, `printings[].type.data`, `printings[].type.data.attributes`, `printings[].type.data.attributes.name`**
  - Type: object, object, object, string. Example: `"Unit"`. Closed set in the data (9): Unit 7,003, Event 1,695, Upgrade 666, Leader 515, Base 260, Token Upgrade 37, Token Unit 30, Credit Token 3, Force Token 2.
  - Meaning: the card type. The digest has six types (base, event, leader, unit, upgrade, token, digest 3.1); the official list splits Token into Token Unit, Token Upgrade, Credit Token and Force Token.
  - **Strategic value**: decides where it goes in a deck (one Leader, one Base, 50+ other cards in Premier, digest 9.2) and what it can be.
  - **Interacts with**: `cost`/`power`/`hp` nullability (see above); `type` drift in TCGplayer (Unit versus Upgrade slips); the classifier refuses to price a Base from a non-Base listing (`conform/rules.ts:60-66`). Tokens are not in a deck and do not count toward deck size (digest 1.2).
- **`printings[].rarity`, `printings[].rarity.data`, `printings[].rarity.data.attributes`, `printings[].rarity.data.attributes.name`**
  - Type: object, object, object, string. Example: `"Common"`. Observed: Common 3,776, Uncommon 2,449, Rare 2,490, Legendary 1,028, Special 468.
  - Meaning: the rarity tier shown on the credit line (digest section 2, item 13). The code does not close this set so a new tier will not break a sync (`api-types.ts:3-8`). Special is the tier used for the extra cards in Spotlight Decks (https://starwarsunlimited.com/articles/homeworlds), Intro Battle: Hoth cards, 66 leaders and some promos; most Special cards are Units (computed from the raw pages).
  - **Strategic value**: drives pull rates and price: Legendary and Special cards are scarcer; a Common reprint is cheap. Collectors track completion per rarity.
  - **Interacts with**: `variantTypes` (a Common's Showcase or Prestige variant is priced far above the Common); `expansion` (rarity ratios per set); drift on `rarity` is recorded (15 in import 43).
- **`printings[].aspects`, `printings[].aspects.data`, `printings[].aspects.data[]`, `printings[].aspects.data[].attributes`, `printings[].aspects.data[].attributes.name`**
  - Type: object, array, object, object, string. Example: `"Vigilance"`. Closed set (6): Heroism 2,929, Villainy 2,835, Command 2,441, Cunning 2,435, Vigilance 2,419, Aggression 2,392. Zero to three entries per printing; no repeats within a printing.
  - Meaning: the aspect icons on the card. Digest 1.5.6: six aspects; a card with no icon is neutral. A Leader or Base provides aspects; every other card requires them (digest section 2, item 6).
  - **Strategic value**: decides which decks can play the card cheaply. A deck's leader and base set its aspect pool; this is the main deck-building constraint.
  - **Interacts with**: the aspect penalty (pay 2 extra resources per icon beyond what leader and base provide, digest 1.5.6 and 8.1); "for free" bypasses it (digest 8.1); `Fortify` ignores penalties on upgrades (the Tarkin text in the data; the digest does not define Fortify). The drift check compares the aspect list for equality, or by inclusion on combo listings (`conform/rules.ts:26-29`).
- **`printings[].expansion`, `printings[].expansion.data`, `printings[].expansion.data.attributes`**
  - Type: object. Structure path. Wraps `code` and `name`.
- **`printings[].expansion.data.attributes.code`**
  - Type: string. Example: `"SOR"`. 29 values in the official list: the nine main sets SOR, SHD, TWI, JTL, LOF, SEC, LAW, ASH, HMW; their weekly-play sets JTLP, LOFP, SECP, LAWP, ASHP, HMWP; and promo codes P25, P26, J24, J25, C24, C25, C26, G25, GG, CST, IBH, IC27, TS26, MV26.
  - Meaning: the set code, used in set and format filters. Snapshots hold 28 codes (one fewer than the official list).
  - **Strategic value**: Premier legality is per set: JTL, LOF, SEC, LAW, ASH and (from 2026-10-09) HMW are legal; SOR, SHD, TWI rotated out ([`docs/concepts/swu-formats.md`](https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md), "Premier legal sets"). A collector reads it as "which set is this from".
  - **Interacts with**: [`docs/concepts/swu-formats.md`](https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md) (rotation); [`packages/shared/src/adapters/swu/formats.ts:46-53`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/shared/src/adapters/swu/formats.ts#L46-L53) lists Premier sets by this code; corrections of `field: "expansion"` rewrite the TCGplayer abbreviation to this code.
- **`printings[].expansion.data.attributes.name`**
  - Type: string. Example: `"Secrets of Power"`. Same 29 values as `code`, in words (for example `"2026 Twin Suns"`, `"Intro Battle: Hoth"`, `"Icons 2027 Edition"`).
  - Meaning: the set's display name.
  - **Strategic value**: display and sorting by release. Promo names flag events: Judge Program, Convention Exclusive, Gamegenic, Costco Exclusive, Movie Promo.
  - **Interacts with**: `code` (one-to-one in the data).
- **`printings[].variantTypes`, `printings[].variantTypes.data`, `printings[].variantTypes.data[]`, `printings[].variantTypes.data[].attributes`**
  - Type: object, array, object, object. Structure paths. The array has exactly one entry for 10,141 official printings and is empty for 70 (mostly promos).
- **`printings[].variantTypes.data[].attributes.name`**
  - Type: string. Example: `"Hyperspace Foil"`. 58 distinct values in the official list: Standard, Hyperspace, Showcase, Standard Foil, Hyperspace Foil, Standard Prestige, Foil Prestige, Serialized Prestige, Weekly Play, Weekly Play Foil, plus event tiers (Judge Program, Convention Exclusive, Prerelease Promo, Event Exclusive, Movie Promo, Costco Exclusive, and the SS, PQ, SQ, RQ, GC families: Participation, Top 64, Top 16, Top 8, Top 4, Finalist, Champion, Judge, Day Two, Day Three, Prize Wall, Event Pack, VIP Promo).
  - Meaning: which finish or tier this printing is. `swuPrintingVariant` folds the first entry into the closed `PrintingVariant` set; anything not listed becomes `promo` (`variant-kind.ts:26-37, 59-66`).
  - **Strategic value**: the biggest price lever on one card. A Hyperspace printing, a Showcase or a Serialized Prestige can be worth many times the Standard one. Event-tier names (Champion, Top 8) mark scarce prizes.
  - **Interacts with**: `foil` and `variantId`; `serialCode` digits 3-4; the price file's `variant`; foil pricing (`price_foil`).
- **`printings[].variantTypes.data[].attributes.variantId`**
  - Type: string. Example: `"32"`. Same 58 values as `name`, as two digits.
  - Meaning: the variant type code (`variant-kind.ts:3-7`): `01` Standard, `02` Hyperspace, `03` Showcase, `06` Standard Prestige, `31` Standard Foil, `32` Hyperspace Foil, `33` Foil Prestige, `34` Serialized Prestige. Other codes are promo tiers. In the 2026-10-16 raw card list, 10,176 printings have one variant and 70 have none. For most of them the code sits in the serial's digits 3-4: 9,227 of 10,176. A further 774 carry it in digits 4-5 (the `p` serials), and 175 match neither (for example `0161001a` is SS Judge, code `45`). Code `60` is Weekly Play only; Event Exclusive is `05`. The serial digits 3-4 equal to `60` appear on six different variant names (Weekly Play, SS Participation, PQ Participation, Event Exclusive, Convention Exclusive, GC Top 64), so the serial alone does not name the variant.
  - **Strategic value**: lets you spot a printing's finish from the serial for about 90% of printings; read `variantId` itself for the rest.
  - **Interacts with**: `serialCode`; the price file's `variant`.
- **`printings[].variantTypes.data[].attributes.foil`**
  - Type: boolean or null. `false` 4,969; `true` 3,456; `null` 1,716 (all promo-type variants).
  - Meaning: whether the variant is a foil. Null means the API does not say (inferred: promo finishes).
  - **Strategic value**: foil cards price separately. Null promos need a manual look.
  - **Interacts with**: `price_foil` versus `price_normal` in the price export; `Foil` in the variant name.
- **`printings[].keywords`, `printings[].keywords.data`, `printings[].keywords.data[]`, `printings[].keywords.data[].attributes`, `printings[].keywords.data[].attributes.name`** (snapshot abba1a4e only)
  - Type: object, array, object, object, string. Example: `"Sentinel"`. Closed set in the data (17): Ambush, Bounty, Coordinate, Exploit, Fortify, Grit, Hidden, Overwhelm, Piloting, Plot, Raid, Restore, Saboteur, Sentinel, Shielded, Smuggle, Support. Zero or more per printing (4,296 printings have at least one).
  - Meaning: the keyword abilities on the card. Digest 7.5 defines each of these except Fortify, Plot and Support, which the digest does not cover (Fortify and Support are explained in "Set 7 to 9 additions"; Plot is not, see below). A leader's own keyword list can include keywords it grants (inferred from "gains Hidden" text).
  - **Strategic value**: the shape of a deck. Sentinel decks wall, Raid and Ambush decks pressure, Overwhelm finishes bases.
  - **Interacts with**: each keyword and what it touches. Ambush: attack when played if an enemy unit exists. Bounty: opponent resolves it when the card is defeated or captured. Coordinate: active with 3+ units. Exploit X: defeat friendly units to reduce cost (also cost). Grit: +1/+0 per damage (power). Hidden: cannot be attacked if played this phase. Overwhelm: excess damage hits the base (hp of a base). Piloting [Y]: play as an upgrade on a Vehicle (see traits). Raid X: +X power while attacking. Restore X: heal X from the base on attack. Saboteur: ignore Sentinel and defeat shields. Sentinel: must be attacked, which constrains attacks within an arena (digest 6.3). Shielded: gives a Shield token when played. Smuggle [Y]: play from resources for Y (cost). Fortify and Support: see "Set 7 to 9 additions" (official articles). Plot: first appears in SEC. Reminder text on the cards: "When you deploy a leader, you may play this card from your resources, paying its cost. Replace it with the top card of your deck."
- **`printings[].traits`, `printings[].traits.data`, `printings[].traits.data[]`, `printings[].traits.data[].attributes`, `printings[].traits.data[].attributes.name`** (snapshot abba1a4e only)
  - Type: object, array, object, object, string. Example: `"Vehicle"`. 59 distinct values: Armor, Bounty, Bounty Hunter, Capital Ship, Clone, Condition, Creature, Disaster, Droid, Ewok, Fighter, First Order, Force, Fortification, Fringe, Gambit, Gungan, Hutt, Imperial, Innate, Inquisitor, Item, Jawa, Jedi, Kaminoan, Law, Learned, Lightsaber, Mandalorian, Modification, Musician, Naboo, New Republic, Night, Nihil, Official, Pilot, Plan, Rebel, Republic, Resistance, Separatist, Sith, Spectre, Speeder, Supply, Tactic, Tank, Transport, Trick, Trooper, Tusken, Twi'lek, Undead, Underworld, Vehicle, Walker, Weapon, Wookiee. Empty on all 258 Bases and 2 Force Tokens in this snapshot, although the digest says bases have traits (digest 3.2): the export drops them or the API leaves them empty (inferred).
  - Meaning: thematic categories printed under the art (digest section 2, item 11).
  - **Strategic value**: tribal and synergy deck building: a Republic deck counts on other Republic cards.
  - **Interacts with**: other cards' text and abilities target traits ("Attach to a non-Vehicle unit", "a Separatist card", "friendly Imperial unit"); `Piloting` needs a Vehicle host; `Plot` and `Exploit` texts reference traits.
- **Not in the trimmed exports** but present in the raw pages: `cardId`, `cardCount`, `unique`, `hyperspace`, `showcase`, `hasFoil`, `type2`, `arenas`, `variantOf`, `reprintOf`, `createdAt`, `updatedAt`, `publishedAt`, `locale` and more. Each is explained in the section "Raw API page".

Image metadata (`printings[].artFront` and every `data.attributes` child under it: alternativeText, caption, height, name, width, formats) exists in snapshots abba1a4e and a9fa9369 and is deliberately out of scope here.

### Which snapshot has which field

Snapshot files are named by the first 8 characters of their sha256.
- `abba1a4e`: everything above, including `keywords`, `traits` and `artFront`.
- `a9fa9369`: everything except `keywords` and `traits`; includes `artFront`.
- `aa0e0918`: `aspects`, `cardNumber`, `rarity`, `serialCode`, `subtitle`, `text`, `title`, `type`, `variantTypes`. No numbers, no expansion, no art.
- `69ceeab2`: `cardNumber`, `serialCode`, `subtitle`, `text`, `title`, `type`, `variantTypes`.
- The official list import 43 holds the conformance subset: no `text`, `deployBox`, `epicAction`, `artist`, `keywords`, `traits`.

## Raw API page

The raw cache keeps the exact API pages, gzipped, one file per page (`page-0001.json.gz` to `page-0103.json.gz` in the 2026-10-16 snapshot, fetched from https://admin.starwarsunlimited.com/api/card-list). Each page body is `{ data: [{ id, attributes }], meta }`. The snapshot holds 10,246 printings with 49 attributes each, 35 more printings than the conformance export's 10,211. Every `serialCode` in the conformance export is also in the raw pages. The schema entry is `#/$defs/RawPage` in [swu-card-data.schema.json](swu-card-data.schema.json); all 103 pages validate against it.

The raw page carries every field the trimmed export drops. The trimmed fields in the Printing section above keep the same names and meaning here, so this section covers only what is new. The complete path list is at the end of the section.

Images: the raw page has image subtrees (`artFront`, `artBack`, `artThumbnail`, the `artFrontHorizontal` and `artBackHorizontal` flags, and the variant `icon`). They are out of scope here. The LLM package (#323) keeps images only as a stem: `https://cdn.starwarsunlimited.com/` plus an optional `<size>_` prefix plus the stem. The size prefixes seen in the data are `card_`, `thumbnail_`, `xsmall_`, `xxsmall_` and `xxxsmall_`, so the URL of a card image is `https://cdn.starwarsunlimited.com/card_SWH_01_001_Director_Krennic_Leader_62eaa20dc2.png` for stem `SWH_01_001_Director_Krennic_Leader_62eaa20dc2.png`.

### Arenas

- **`data[].attributes.arenas`**, **`data[].attributes.arenas.data`**, **`data[].attributes.arenas.data[]`**, **`data[].attributes.arenas.data[].attributes.name`**
  - Type: object, array, object, string. Example: `"Ground"`. Closed set of two: Ground on 5,731 printings, Space on 1,841. No printing lists both. The array is empty for Events, Bases, Upgrades, Credit and Force tokens (and for two Hardpoint Heavy Blaster Units, a gap in the data).
  - Meaning: where the card fights. Digest 4.3: the Ground arena is the shared zone for ground units; digest 4.4: the Space arena is the shared zone for space units on the opposite side. Units attack within their arena or at the enemy base. The three Space Leaders are all Grand Moff Tarkin printings, because his deploy side is the Death Star, "the game's first true space leader" (https://starwarsunlimited.com/articles/defend-and-destroy). A Leader's arena is the arena its unit side deploys into.
  - **Strategic value**: decides which fights a card can take part in and which defenders can block it. A deck short on Space units cannot contest the space arena.
  - **Interacts with**: Sentinel (its reminder text reads "Units in this arena can't attack your non-Sentinel units or your base", so a Ground Sentinel stops Ground attackers only); Saboteur (ignores Sentinel); Piloting (a Pilot attaches to a Vehicle, which is usually a Space unit); Hidden and Ambush (both act inside the arena); `type` (only Units, Token Units and Leaders have an arena).

### Counters and flags

- **`data[].attributes.unique`**: boolean. True on 4,495 printings: all 515 Leaders, 3,873 Units and 107 Upgrades. Meaning: the Unique icon (digest 8.30): you may control one copy per player in play, and extra copies are defeated immediately. **Strategic value**: you may still run 3 copies in a Premier deck (digest 9.2), but the second one in play is dead, so unique cards are usually run at fewer copies. **Interacts with**: `title` and `subtitle` (the subtitle tells two versions of a unique character apart, digest 8.30); Leaders (all unique).
- **`data[].attributes.hasFoil`**: boolean. True on 9,133 printings. Meaning: a foil version of the printing exists in the set's product. **Strategic value**: a false value means no foil price to chase. **Interacts with**: `variantTypes[].foil` and the price file's `price_foil`.
- **`data[].attributes.hyperspace`**: boolean. True on 938 printings; the Hyperspace variant name occurs on 2,372. Meaning: an API flag that agrees with the variant on only part of the data (inferred), so use `variantTypes` as the source of truth. **Interacts with**: `variantTypes[].name`.
- **`data[].attributes.showcase`**: boolean. True on 34 printings; the Showcase variant name occurs on 162 Leaders (inferred: same partial flag). **Interacts with**: `variantTypes[].name`.
- **`data[].attributes.cardCount`**: integer. Values 252, 257, 262, 264, 272 for the main sets, 0 for promos and weekly play, small values for product sets (for example 104 for Intro Battle: Hoth, 194 for Icons 2027 Edition). Meaning: the size of the set the card belongs to, as the set's own count (inferred). **Strategic value**: lets a collector compute set completion. **Interacts with**: `cardNumber` (a number above the count is a variant or secret-rare slot, inferred) and `expansion`.

### Upgrade modifiers

- **`data[].attributes.upgradeHp`**, **`data[].attributes.upgradePower`**
  - Type: integer or null. Non-null on 853 printings: 616 Upgrades, 15 token upgrades, 189 Units and 33 Leaders (the Pilot cards, which are played as upgrades). Values from -2 to 5. Example: Luke's Lightsaber has `upgradePower` 3 and `upgradeHp` 1; Perilous Position has -2 and -2; the Weakness token has -1 and -1.
  - Meaning: the stat change the card gives the unit it attaches to (digest section 2, items 8 and 10: power and HP modifiers on upgrades and Pilot units). On these cards the plain `power` and `hp` stay null, which is why the trimmed export shows upgrades with null stats. One exception: the Advantage token keeps its +1/+0 in `power` and `hp` (power 1, hp 0) and leaves these two null (inferred).
  - **Strategic value**: what an upgrade or Pilot is worth on a body. A +3/+1 upgrade on a cheap unit is a card-efficient threat.
  - **Interacts with**: `cost` (stat per resource), `type` (Upgrade, Token Upgrade, Leader), `keywords` (Piloting, Fortify, Grit), and removal (the upgrade is defeated when its unit leaves play, digest 3.6).

### Second type and aspect duplicates

- **`data[].attributes.type2`**, **`data[].attributes.type2.data`** and its attributes: object or null. Non-null on 517 printings: `Leader Unit` on 512 Leaders, `Leader` on 3 Leaders, `Upgrade` on 2 Token Upgrades. Meaning: the second face of a double-sided card. A Leader card is a Leader on one side and a Leader Unit on the other (digest 3.4). **Strategic value**: tells you the card has a deployed form. **Interacts with**: `deployBox` (the unit side's text), `epicAction` (the deploy condition), `upgradePower` and `upgradeHp` (set on 33 Leaders that are also Pilots).
- **`data[].attributes.aspectDuplicates`**: object holding an array of aspects. Non-empty on 250 printings, for example a Vigilance card that prints the Vigilance icon twice. Meaning (inferred): the aspects the card shows a second time, i.e. a double icon. **Strategic value**: a double-icon card is harder to play out of aspect. **Interacts with**: `aspects`, and the aspect penalty (digest 1.5.6 and 8.1: 2 extra resources for each icon your leader and base do not provide), so each duplicate can add a further 2.

### Rulings and styled text

- **`data[].attributes.rules`**: string or null. Present on 4,441 printings. Official rulings and clarifications for the card as plain text, one paragraph per ruling. Example (Fleet Lieutenant): `Units must be ready in order to attack.` Some are general keyword notes ("Ambush is an ability that triggers at the same time as 'When Played' abilities."). **Strategic value**: settles edge cases in play and in judging. **Interacts with**: `keywords` and `text`.
- **`data[].attributes.rulesStyled`**: string or null. The same rulings as HTML, with a table whose first column is the ruling date (for example `3/1/2024`). A string on 4,810 printings in the 2026-10-16 raw card list, of which 380 are empty; the other 4,430 each have a plain-text `rules` copy. Three printings have a plain ruling but no styled one. **Interacts with**: `rules`.
- **`data[].attributes.textStyled`**: string. The rules text as HTML: `<p>`, `<strong>`, `<i>`, cost icons as `<img>` links and a custom `<sKey>` tag around keywords. Never null; `<p></p>` when the card has no text. **`data[].attributes.deployBoxStyled`**: string or null. The deploy text as HTML (2,360 strings, many empty). **`data[].attributes.epicActionStyled`**: string or null. The Epic Action text as HTML. **Strategic value**: lets a viewer show bold keywords and cost icons. **Interacts with**: `text`, `deployBox`, `epicAction` (each styled field is the HTML form of its plain twin).

### Identifiers and links

- **`data[].id`**: integer. The Strapi record id; unique per printing, not stable across environments. **`data[].attributes.cardUid`**: string, for example `"2579145458"`. The official card id, unique for all 10,246 printings. **`data[].attributes.cardId`**: string or null. An older id, non-null on only 135 printings and equal to `cardUid` on 60 of them. **`data[].attributes.validationId`**: string. 2,760 distinct values over 10,246 printings: the id shared by the printings of one card (a Standard and its Hyperspace copy share it), except 52 groups that mix different titles (inferred). **Strategic value**: `validationId` groups printings into one card for collection counts. **Interacts with**: `serialCode` (still the unique printing id and the join key to prices), `variantOf`, `reprintOf`.
- **`data[].attributes.linkHtml`**: string. The anchor the official site uses to link to the card: `<a href="/cards?cid=<cardUid>" class="card-tooltip" data-card="<cardUid>">Title</a>`. Holds `cardUid` in every record.

### Variant and reprint links

- **`data[].attributes.variantOf`**: object whose `data` is null on 3,099 printings and a copy of the root printing on 7,147. Every Hyperspace, Standard Foil, Hyperspace Foil and Prestige printing points to its Standard printing (children in the data: Hyperspace 2,372, Standard Foil 1,368, Hyperspace Foil 2,082, each Prestige tier 259). The Standard printings (2,632) are roots. **Strategic value**: lets you roll variants up to one card and compare the price of each variant to the root. **Interacts with**: `variantTypes`, `serialCode`, `validationId`.
- **`data[].attributes.reprintOf`**: object whose `data` is null on 9,695 printings and a copy of the earlier printing on 551. Example: Death Trooper `0201030` reprints `0101033` from Spark of Rebellion. **Strategic value**: a reprint keeps the same card legal in Premier when any reprint is in a legal set ([`docs/concepts/swu-formats.md`](https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md), Formats). **Interacts with**: `expansion` and `swu-formats.md` in mault.
- The copied records under `variantOf.data.attributes` and `reprintOf.data.attributes` carry the scalar card attributes only (no relations, and no `validationId`). Each field means what it means on the printing itself.

### Localizations

- **`data[].attributes.localizations`**: object holding an array of the same card in other languages: German `de`, Spanish `es`, French `fr` and Italian `it`, about 10,240 each. Each copy has the scalar fields (title, subtitle, text, rules and the styled HTML) translated and no relations. Example: Luke Skywalker, subtitle "Faithful Friend" is "Amigo Leal" in `es`. **Strategic value**: the way to show or search a card in a player's language. **Interacts with**: `serialCode` (the same in every language).

### Relation bookkeeping fields

Each relation entry (aspect, trait, keyword, arena, type, rarity, expansion, variant type) is a Strapi record with its own `id`, `createdAt`, `updatedAt`, `publishedAt` and `locale` (always `en`). Beyond that:
- Aspects (`aspects`, `aspectDuplicates`) carry `description` (the official one-line playstyle text), `englishName`, `color` (hex) and `sortValue` (Vigilance 1, Command 5, Aggression 10, Cunning 15, Villainy 20, Heroism 25).
- Rarities carry `character` (C, U, R, L or S), `color`, `englishName` and `sortValue`.
- Types and `type2` carry `value` (the group: Leader, Base, Unit, Event, Upgrade, Leader Unit or Token), `description` (the empty string on all but one type) and `sortValue`.
- Expansions carry `sortValue` (a release-order key: SOR 19, SHD 29, TWI 39, JTL 49, LOF 59, SEC 69, LAW 79, ASH 99, HMW 109), `description` (non-null for about half of the sets) and two always-null leaderboard dates.
- Variant types carry `sortValue` and an always-null `description`, plus an `icon` image (out of scope).
- Keywords carry a `description` that is null or empty for every keyword except Saboteur; Traits carry a `description` that is null for all but a handful.
- **Strategic value**: `sortValue` gives the official display order for sorting aspects, rarities and sets, and the release order of sets.

### Paging

- **`meta.pagination.page`**, **`meta.pagination.pageSize`**, **`meta.pagination.pageCount`**, **`meta.pagination.total`**: integers. Page number (1 to 103), 100 records per page, 103 pages, 10,246 printings. Interacts with: the manifest in the raw cache, which lists each page's URL, byte length and sha256.

### Complete path reference

Every non-image path in the 103 raw pages, with its observed types and the number of printings (or pages) where it is present. Paths under `variantOf`, `reprintOf` and `localizations` repeat the printing's own scalar attributes with the same meaning. Image subtrees (`artFront`, `artBack`, `artThumbnail`, `artFrontHorizontal`, `artBackHorizontal`, variant `icon`) are left out on purpose.

<!-- raw-ref:start -->
- `data[]`: {"object":10246}; present in 10246
- `data[].attributes`: {"object":10246}; present in 10246
- `data[].attributes.arenas`: {"object":10246}; present in 10246
- `data[].attributes.arenas.data`: {"array":10246}; present in 10246
- `data[].attributes.arenas.data[]`: {"object":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes`: {"object":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.createdAt`: {"string":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.description`: {"null":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.locale`: {"string":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.name`: {"string":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.publishedAt`: {"string":7572}; present in 7572
- `data[].attributes.arenas.data[].attributes.updatedAt`: {"string":7572}; present in 7572
- `data[].attributes.arenas.data[].id`: {"integer":7572}; present in 7572
- `data[].attributes.artist`: {"string":10246}; present in 10246
- `data[].attributes.aspectDuplicates`: {"object":10246}; present in 10246
- `data[].attributes.aspectDuplicates.data`: {"array":10246}; present in 10246
- `data[].attributes.aspectDuplicates.data[]`: {"object":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes`: {"object":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.color`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.createdAt`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.description`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.englishName`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.locale`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.name`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.publishedAt`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.sortValue`: {"integer":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].attributes.updatedAt`: {"string":250}; present in 250
- `data[].attributes.aspectDuplicates.data[].id`: {"integer":250}; present in 250
- `data[].attributes.aspects`: {"object":10246}; present in 10246
- `data[].attributes.aspects.data`: {"array":10246}; present in 10246
- `data[].attributes.aspects.data[]`: {"object":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes`: {"object":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.color`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.createdAt`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.description`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.englishName`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.locale`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.name`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.publishedAt`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.sortValue`: {"integer":15505}; present in 9945
- `data[].attributes.aspects.data[].attributes.updatedAt`: {"string":15505}; present in 9945
- `data[].attributes.aspects.data[].id`: {"integer":15505}; present in 9945
- `data[].attributes.cardCount`: {"integer":10246}; present in 10246
- `data[].attributes.cardId`: {"string":135,"null":10111}; present in 10246
- `data[].attributes.cardNumber`: {"integer":10246}; present in 10246
- `data[].attributes.cardUid`: {"string":10246}; present in 10246
- `data[].attributes.cost`: {"integer":9976,"null":270}; present in 10246
- `data[].attributes.createdAt`: {"string":10246}; present in 10246
- `data[].attributes.deployBox`: {"string":515,"null":9731}; present in 10246
- `data[].attributes.deployBoxStyled`: {"string":2360,"null":7886}; present in 10246
- `data[].attributes.epicAction`: {"string":7329,"null":2917}; present in 10246
- `data[].attributes.epicActionStyled`: {"string":9007,"null":1239}; present in 10246
- `data[].attributes.expansion`: {"object":10246}; present in 10246
- `data[].attributes.expansion.data`: {"object":10246}; present in 10246
- `data[].attributes.expansion.data.attributes`: {"object":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.code`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.createdAt`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.description`: {"string":5604,"null":4642}; present in 10246
- `data[].attributes.expansion.data.attributes.leaderboardEndDate`: {"null":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.leaderboardStartDate`: {"null":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.locale`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.name`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.publishedAt`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.sortValue`: {"integer":10246}; present in 10246
- `data[].attributes.expansion.data.attributes.updatedAt`: {"string":10246}; present in 10246
- `data[].attributes.expansion.data.id`: {"integer":10246}; present in 10246
- `data[].attributes.hasFoil`: {"boolean":10246}; present in 10246
- `data[].attributes.hp`: {"integer":7853,"null":2393}; present in 10246
- `data[].attributes.hyperspace`: {"boolean":10246}; present in 10246
- `data[].attributes.keywords`: {"object":10246}; present in 10246
- `data[].attributes.keywords.data`: {"array":10246}; present in 10246
- `data[].attributes.keywords.data[]`: {"object":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes`: {"object":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes.createdAt`: {"string":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes.description`: {"string":4865,"null":343}; present in 4308
- `data[].attributes.keywords.data[].attributes.locale`: {"string":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes.name`: {"string":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes.publishedAt`: {"string":5208}; present in 4308
- `data[].attributes.keywords.data[].attributes.updatedAt`: {"string":5208}; present in 4308
- `data[].attributes.keywords.data[].id`: {"integer":5208}; present in 4308
- `data[].attributes.linkHtml`: {"string":10246}; present in 10246
- `data[].attributes.locale`: {"string":10246}; present in 10246
- `data[].attributes.localizations`: {"object":10246}; present in 10246
- `data[].attributes.localizations.data`: {"array":10246}; present in 10246
- `data[].attributes.localizations.data[]`: {"object":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes`: {"object":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.artist`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.cardCount`: {"integer":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.cardId`: {"string":537,"null":40413}; present in 10243
- `data[].attributes.localizations.data[].attributes.cardNumber`: {"integer":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.cardUid`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.cost`: {"integer":39872,"null":1078}; present in 10243
- `data[].attributes.localizations.data[].attributes.createdAt`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.deployBox`: {"string":2050,"null":38900}; present in 10243
- `data[].attributes.localizations.data[].attributes.deployBoxStyled`: {"string":8131,"null":32819}; present in 10243
- `data[].attributes.localizations.data[].attributes.epicAction`: {"string":29304,"null":11646}; present in 10243
- `data[].attributes.localizations.data[].attributes.epicActionStyled`: {"string":35010,"null":5940}; present in 10243
- `data[].attributes.localizations.data[].attributes.hasFoil`: {"boolean":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.hp`: {"integer":31378,"null":9572}; present in 10243
- `data[].attributes.localizations.data[].attributes.hyperspace`: {"boolean":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.linkHtml`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.locale`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.power`: {"integer":30332,"null":10618}; present in 10243
- `data[].attributes.localizations.data[].attributes.publishedAt`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.rules`: {"null":23770,"string":17180}; present in 10243
- `data[].attributes.localizations.data[].attributes.rulesStyled`: {"null":22822,"string":18128}; present in 10243
- `data[].attributes.localizations.data[].attributes.serialCode`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.showcase`: {"boolean":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.subtitle`: {"string":38131,"null":2819}; present in 10243
- `data[].attributes.localizations.data[].attributes.text`: {"string":40695,"null":255}; present in 10243
- `data[].attributes.localizations.data[].attributes.textStyled`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.title`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.unique`: {"boolean":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.updatedAt`: {"string":40950}; present in 10243
- `data[].attributes.localizations.data[].attributes.upgradeHp`: {"null":37730,"integer":3220}; present in 10243
- `data[].attributes.localizations.data[].attributes.upgradePower`: {"null":37730,"integer":3220}; present in 10243
- `data[].attributes.localizations.data[].id`: {"integer":40950}; present in 10243
- `data[].attributes.power`: {"integer":7591,"null":2655}; present in 10246
- `data[].attributes.publishedAt`: {"string":10246}; present in 10246
- `data[].attributes.rarity`: {"object":10246}; present in 10246
- `data[].attributes.rarity.data`: {"object":10246}; present in 10246
- `data[].attributes.rarity.data.attributes`: {"object":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.character`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.color`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.createdAt`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.englishName`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.locale`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.name`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.publishedAt`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.sortValue`: {"integer":10246}; present in 10246
- `data[].attributes.rarity.data.attributes.updatedAt`: {"string":10246}; present in 10246
- `data[].attributes.rarity.data.id`: {"integer":10246}; present in 10246
- `data[].attributes.reprintOf`: {"object":10246}; present in 10246
- `data[].attributes.reprintOf.data`: {"null":9695,"object":551}; present in 10246
- `data[].attributes.reprintOf.data.attributes`: {"object":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.artist`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.cardCount`: {"integer":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.cardId`: {"null":520,"string":31}; present in 551
- `data[].attributes.reprintOf.data.attributes.cardNumber`: {"integer":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.cardUid`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.cost`: {"integer":533,"null":18}; present in 551
- `data[].attributes.reprintOf.data.attributes.createdAt`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.deployBox`: {"null":540,"string":11}; present in 551
- `data[].attributes.reprintOf.data.attributes.deployBoxStyled`: {"string":196,"null":355}; present in 551
- `data[].attributes.reprintOf.data.attributes.epicAction`: {"null":128,"string":423}; present in 551
- `data[].attributes.reprintOf.data.attributes.epicActionStyled`: {"string":542,"null":9}; present in 551
- `data[].attributes.reprintOf.data.attributes.hasFoil`: {"boolean":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.hp`: {"integer":467,"null":84}; present in 551
- `data[].attributes.reprintOf.data.attributes.hyperspace`: {"boolean":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.linkHtml`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.locale`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.power`: {"integer":450,"null":101}; present in 551
- `data[].attributes.reprintOf.data.attributes.publishedAt`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.rules`: {"string":276,"null":275}; present in 551
- `data[].attributes.reprintOf.data.attributes.rulesStyled`: {"string":321,"null":230}; present in 551
- `data[].attributes.reprintOf.data.attributes.serialCode`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.showcase`: {"boolean":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.subtitle`: {"null":58,"string":493}; present in 551
- `data[].attributes.reprintOf.data.attributes.text`: {"string":538,"null":13}; present in 551
- `data[].attributes.reprintOf.data.attributes.textStyled`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.title`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.unique`: {"boolean":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.updatedAt`: {"string":551}; present in 551
- `data[].attributes.reprintOf.data.attributes.upgradeHp`: {"null":505,"integer":46}; present in 551
- `data[].attributes.reprintOf.data.attributes.upgradePower`: {"null":505,"integer":46}; present in 551
- `data[].attributes.reprintOf.data.id`: {"integer":551}; present in 551
- `data[].attributes.rules`: {"null":5805,"string":4441}; present in 10246
- `data[].attributes.rulesStyled`: {"null":5436,"string":4810}; present in 10246
- `data[].attributes.serialCode`: {"string":10246}; present in 10246
- `data[].attributes.showcase`: {"boolean":10246}; present in 10246
- `data[].attributes.subtitle`: {"string":9540,"null":706}; present in 10246
- `data[].attributes.text`: {"string":10182,"null":64}; present in 10246
- `data[].attributes.textStyled`: {"string":10246}; present in 10246
- `data[].attributes.title`: {"string":10246}; present in 10246
- `data[].attributes.traits`: {"object":10246}; present in 10246
- `data[].attributes.traits.data`: {"array":10246}; present in 10246
- `data[].attributes.traits.data[]`: {"object":19458}; present in 9982
- `data[].attributes.traits.data[].attributes`: {"object":19458}; present in 9982
- `data[].attributes.traits.data[].attributes.createdAt`: {"string":19458}; present in 9982
- `data[].attributes.traits.data[].attributes.description`: {"string":19407,"null":51}; present in 9982
- `data[].attributes.traits.data[].attributes.locale`: {"string":19458}; present in 9982
- `data[].attributes.traits.data[].attributes.name`: {"string":19458}; present in 9982
- `data[].attributes.traits.data[].attributes.publishedAt`: {"string":19458}; present in 9982
- `data[].attributes.traits.data[].attributes.updatedAt`: {"string":19458}; present in 9982
- `data[].attributes.traits.data[].id`: {"integer":19458}; present in 9982
- `data[].attributes.type`: {"object":10246}; present in 10246
- `data[].attributes.type.data`: {"object":10246}; present in 10246
- `data[].attributes.type.data.attributes`: {"object":10246}; present in 10246
- `data[].attributes.type.data.attributes.createdAt`: {"string":10246}; present in 10246
- `data[].attributes.type.data.attributes.description`: {"string":10243,"null":3}; present in 10246
- `data[].attributes.type.data.attributes.locale`: {"string":10246}; present in 10246
- `data[].attributes.type.data.attributes.name`: {"string":10246}; present in 10246
- `data[].attributes.type.data.attributes.publishedAt`: {"string":10246}; present in 10246
- `data[].attributes.type.data.attributes.sortValue`: {"integer":10246}; present in 10246
- `data[].attributes.type.data.attributes.updatedAt`: {"string":10246}; present in 10246
- `data[].attributes.type.data.attributes.value`: {"string":10246}; present in 10246
- `data[].attributes.type.data.id`: {"integer":10246}; present in 10246
- `data[].attributes.type2`: {"object":10246}; present in 10246
- `data[].attributes.type2.data`: {"object":517,"null":9729}; present in 10246
- `data[].attributes.type2.data.attributes`: {"object":517}; present in 517
- `data[].attributes.type2.data.attributes.createdAt`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.description`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.locale`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.name`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.publishedAt`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.sortValue`: {"integer":517}; present in 517
- `data[].attributes.type2.data.attributes.updatedAt`: {"string":517}; present in 517
- `data[].attributes.type2.data.attributes.value`: {"string":517}; present in 517
- `data[].attributes.type2.data.id`: {"integer":517}; present in 517
- `data[].attributes.unique`: {"boolean":10246}; present in 10246
- `data[].attributes.updatedAt`: {"string":10246}; present in 10246
- `data[].attributes.upgradeHp`: {"null":9393,"integer":853}; present in 10246
- `data[].attributes.upgradePower`: {"null":9393,"integer":853}; present in 10246
- `data[].attributes.validationId`: {"string":10246}; present in 10246
- `data[].attributes.variantOf`: {"object":10246}; present in 10246
- `data[].attributes.variantOf.data`: {"null":3099,"object":7147}; present in 10246
- `data[].attributes.variantOf.data.attributes`: {"object":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.artist`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.cardCount`: {"integer":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.cardId`: {"null":6988,"string":159}; present in 7147
- `data[].attributes.variantOf.data.attributes.cardNumber`: {"integer":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.cardUid`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.cost`: {"integer":7004,"null":143}; present in 7147
- `data[].attributes.variantOf.data.attributes.createdAt`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.deployBox`: {"string":330,"null":6817}; present in 7147
- `data[].attributes.variantOf.data.attributes.deployBoxStyled`: {"string":2336,"null":4811}; present in 7147
- `data[].attributes.variantOf.data.attributes.epicAction`: {"string":5012,"null":2135}; present in 7147
- `data[].attributes.variantOf.data.attributes.epicActionStyled`: {"string":6635,"null":512}; present in 7147
- `data[].attributes.variantOf.data.attributes.hasFoil`: {"boolean":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.hp`: {"integer":5480,"null":1667}; present in 7147
- `data[].attributes.variantOf.data.attributes.hyperspace`: {"boolean":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.linkHtml`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.locale`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.power`: {"integer":5341,"null":1806}; present in 7147
- `data[].attributes.variantOf.data.attributes.publishedAt`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.rules`: {"string":3221,"null":3926}; present in 7147
- `data[].attributes.variantOf.data.attributes.rulesStyled`: {"string":3922,"null":3225}; present in 7147
- `data[].attributes.variantOf.data.attributes.serialCode`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.showcase`: {"boolean":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.subtitle`: {"string":6626,"null":521}; present in 7147
- `data[].attributes.variantOf.data.attributes.text`: {"string":7107,"null":40}; present in 7147
- `data[].attributes.variantOf.data.attributes.textStyled`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.title`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.unique`: {"boolean":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.updatedAt`: {"string":7147}; present in 7147
- `data[].attributes.variantOf.data.attributes.upgradeHp`: {"null":6551,"integer":596}; present in 7147
- `data[].attributes.variantOf.data.attributes.upgradePower`: {"null":6551,"integer":596}; present in 7147
- `data[].attributes.variantOf.data.id`: {"integer":7147}; present in 7147
- `data[].attributes.variantTypes`: {"object":10246}; present in 10246
- `data[].attributes.variantTypes.data`: {"array":10246}; present in 10246
- `data[].attributes.variantTypes.data[]`: {"object":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes`: {"object":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.createdAt`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.description`: {"null":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.foil`: {"boolean":8460,"null":1716}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.locale`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.name`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.publishedAt`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.sortValue`: {"integer":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.updatedAt`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].attributes.variantId`: {"string":10176}; present in 10176
- `data[].attributes.variantTypes.data[].id`: {"integer":10176}; present in 10176
- `data[].id`: {"integer":10246}; present in 10246
- `meta`: {"object":103}; present in 103
- `meta.pagination`: {"object":103}; present in 103
- `meta.pagination.page`: {"integer":103}; present in 103
- `meta.pagination.pageCount`: {"integer":103}; present in 103
- `meta.pagination.pageSize`: {"integer":103}; present in 103
- `meta.pagination.total`: {"integer":103}; present in 103
<!-- raw-ref:end -->


## Price import

One row of `price_imports` ([`packages/server/src/db/schema.ts:972-993`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/server/src/db/schema.ts#L972-L993)). Lives under the key `import` in the price export. A run is "conformed" when every TCGplayer listing is either matched to one official printing or quarantined.

- **`import.id`**: integer, `43`. The import id. Every price row carries it as `import_id`. Strategic value: names the run you audit.
- **`import.game_key`**: string, `"swu"`. Which game's adapter ran. Interacts with the unique "one current import per game" index (schema.ts:989-991).
- **`import.status`**: string, `"succeeded"`. One of running, succeeded, failed ([`packages/shared/src/schemas/price.schema.ts:331`](https://github.com/LampaGJ/mault/blob/feature/swu-support/packages/shared/src/schemas/price.schema.ts#L331)). A failed run keeps its `error` text.
- **`import.started_at`**, **`import.finished_at`**: strings, timestamps with no timezone suffix (UTC by the README), for example `"2026-10-16T05:05:00.027"`. Strategic value: how fresh the prices are. Prices are TCGplayer market prices as of the fetch.
- **`import.tcg_blob_sha256`**, **`import.official_blob_sha256`**: sha256 hex strings. The pinned TCGCSV snapshot and the pinned official card list the run consumed (schema.ts:976-978). They make the run replayable: the same inputs and commit must produce the same `output_hash`.
- **`import.code_commit`**: string, `"99007fdf0573fba77d4c4392a7b126d8fc251b12-dirty"`. The git commit of the conform code; the `-dirty` suffix means the working tree had uncommitted changes (inferred from the suffix).
- **`import.output_hash`**: sha256 hex. The hash of the conformed output. Replay proof: same inputs and commit give the same hash.
- **`import.counts`**: object (`PriceImportCounts`, price.schema.ts:296-324). Per-class totals. Its children:
  - **`import.counts.products`**: 9,114. TCGplayer products read.
  - **`import.counts.skippedNoNumber`**: 110. Sealed product and similar with no card number; not conformed.
  - **`import.counts.conformant`**: 7,124. Matched with no correction and no drift.
  - **`import.counts.corrected`**: 895. Matched after at least one committed rule fired.
  - **`import.counts.descriptiveDrift`**: 863. Matched, but TCGplayer disagrees on a printed stat.
  - **`import.counts.driftWarnings`**: 9. Drift on 3 or more fields; the price stays current but is flagged (`conform/rules.ts:8`).
  - **`import.counts.quarantined`**: 122. Listings rejected.
  - **`import.counts.pointsPriced`**: 8,354. Cards that received a price point (one per `card_id`, not per product).
  - **`import.counts.suspect`**: 0. Price points flagged by the movement check as suspicious jumps.
  - **`import.counts.byRule`**: object. Corrections applied per rule; see "Correction". Children: `import.counts.byRule.promo-group` (606), `import.counts.byRule.combo-base` (332), `import.counts.byRule.group-set` (6), `import.counts.byRule.exclusive-set` (2), `import.counts.byRule.token-number` (2), `import.counts.byRule.title-drift` (26), `import.counts.byRule.number-shift` (5), `import.counts.byRule.promo-number` (55), `import.counts.byRule.verified-listing` (4).
  - **`import.counts.byReason`**: object. Quarantines per reason; see "Quarantine". Children: `import.counts.byReason.ambiguous` (0), `import.counts.byReason.duplicate-claim` (12), `import.counts.byReason.field-disagreement` (7), `import.counts.byReason.no-candidate` (44), `import.counts.byReason.unknown-variant-suffix` (52), `import.counts.byReason.unmapped-group` (0), `import.counts.byReason.unparseable-number` (7).
  - **`import.counts.byDriftField`**: object. Drifted fields per stat. Children: `import.counts.byDriftField.aspects` (31), `import.counts.byDriftField.cost` (8), `import.counts.byDriftField.hp` (767), `import.counts.byDriftField.power` (330), `import.counts.byDriftField.rarity` (15), `import.counts.byDriftField.type` (35).
  - **Strategic value** of all counts: a reviewer decides whether to trust the run. A jump in `quarantined` or `suspect` after a new set release means a new rule is needed.
  - **Interacts with**: `tcg_printings.conformance`, the quarantine and corrections files (counts must match their row counts: 895 corrected, 863 drift, 122 quarantined here).
- **Not in this export**: `previous_points_blob_sha256`, `is_current`, `error` exist on the table (schema.ts:974-985) but were not exported (`error` is null on a succeeded run).

## TCG printing

One row of `tcg_printings` (schema.ts:1004-1023), under `printings[]` in the price export. One row is one TCGplayer product matched to one official printing. Primary key: `(import_id, card_id, product_id)`.

- **`printings[].import_id`**: integer, `43` on all rows. Foreign key to `import.id`.
- **`printings[].card_id`**: string, `"04010019"`. 8,654 distinct values over 8,882 rows. This is the official `serialCode`. Strategic value: the join to everything else. Interacts with: several products can map to one card, which is how combo listings (card plus token) land on the same id (see `combo_token_ref`).
- **`printings[].product_id`**: integer, `540376`. TCGplayer's id for the listing; unique per row (8,882 distinct). Join key to the corrections and quarantine files. Strategic value: the id you paste into a TCGplayer URL to see the listing.
- **`printings[].group_id`**: integer, `24279`. TCGplayer's "group", roughly one per set or promo family; 31 distinct. Interacts with the group mapping that scopes classification by set (`conform/rules.ts:159`). Same group id appears on quarantine rows.
- **`printings[].variant`**: string, closed set of 11 (`price.schema.ts:11-26`): standard 2,642, hyperspace 2,447, hyperspace-foil 1,432, standard-foil 712, promo 475, prestige 259, prestige-foil 259, prestige-serialized 259, showcase 161, weekly-play 136, weekly-play-foil 100. Meaning: the shared variant vocabulary that stops a Hyperspace listing from pricing a Standard printing. Strategic value: tells you which version the price describes. Interacts with: official `variantTypes[0].name`, via `swuPrintingVariant` (`variant-kind.ts:59-66`).
- **`printings[].price_normal`**: number or null. Example: `0.08`. Null on 3,327 rows. Meaning: the non-foil market price in US dollars (inferred: TCGplayer `marketPrice` for the "Normal" sub-type, `conform/conform.ts:57`; the minimum is taken if a product has duplicate rows). Strategic value: what a non-foil copy sells for; what the sorter uses to route a card to a "bulk" or "valuable" bin. Interacts with: `variant` (a Standard printing's normal price is the bulk number) and `price_source`.
- **`printings[].price_foil`**: number or null. Example: `0.13`. Null on 4,538 rows. Meaning: the foil market price, from the "Foil" sub-type (`conform/conform.ts:58`). Strategic value: foil premium for collectors. Interacts with: official `foil` flag; `variant` (a `-foil` variant is expected to carry `price_foil`).
- **`printings[].price_source`**: string, `direct` (8,550) or `combo` (332) (`price.schema.ts:36`). Meaning: `direct` is a single-card listing; `combo` is a card-plus-token listing, the only way TCGplayer lists some bases and token-bearing cards. Strategic value: a combo price includes a token's worth and is a ceiling, not a single-card price. Interacts with: `combo_token_ref`; the `combo-base` rule; `pricePoints()` prefers a priced direct row and falls back to the cheapest combo (`conform/conform.ts:103-113`).
- **`printings[].combo_token_ref`**: string or null. Example: `"T04"`, `"T03/T04"`, `"T02//T02"`. Non-null on 332 rows (all `combo`). Meaning: which token(s) the combo includes, parsed from the TCGplayer number (`conform/normalize.ts:112-117`). The 19 observed forms include a double-slash typo, `T02//T02`, which is TCGplayer's own text. Strategic value: tells you which token you get in the bundle. Interacts with: official `Token Unit` and `Token Upgrade` types (the tokens are separate official printings, such as Experience and Shield).
- **`printings[].conformance`**: string: `conformant` 7,124, `corrected` 895, `descriptive-drift` 863. Meaning: how the match was reached. Strategic value: a trust level. `conformant` is cleanest. Interacts with: `applied_rules` and `drift`; matches `import.counts`.
- **`printings[].applied_rules`**: array of strings; empty on 7,905 rows. **`printings[].applied_rules[]`**: string, one of the nine rule ids (606 `promo-group`, 332 `combo-base`, 55 `promo-number`, 26 `title-drift`, 6 `group-set`, 5 `number-shift`, 4 `verified-listing`, 2 `token-number`, 2 `exclusive-set`; 1,038 entries across 977 rows). Meaning: the committed rules that rewrote this listing, in run order. Interacts with: the corrections file (same `product_id`, `seq` is the position in this list).
- **`printings[].drift`**: object or null. Null on 8,019 rows; an object on the 863 `descriptive-drift` rows. Meaning: where TCGplayer's printed stats differ from the official card (`PrintingDriftRecord`, `price.schema.ts:125-130`). Strategic value: warns that the price is attached to the right printing but the listing data is sloppy.
  - **`printings[].drift.drift`**: array of objects (1,186 entries over 863 rows). **`printings[].drift.drift[]`**: one entry.
    - **`printings[].drift.drift[].field`**: string, one of hp 767, power 330, type 35, aspects 31, rarity 15, cost 8 (`price.schema.ts:97`).
    - **`printings[].drift.drift[].tcg`**: string or null. What TCGplayer lists, as text. Null when TCGplayer lists nothing (445 times). Example: `"3"`, `"unit"`, `"Vigilance;Villainy"`-style joined aspects (`conform/rules.ts:47`).
    - **`printings[].drift.drift[].official`**: string or null. The official value as text. Null 203 times (the card has none, such as an upgrade with no printed HP).
  - **`printings[].drift.driftWarning`**: object or null. Null on 854 rows; an object on 9. Set when drift touches 3 or more fields. Meaning: a human should look at it; the price is not withheld (`price.schema.ts:112-118`).
    - **`printings[].drift.driftWarning.count`**: integer, 3 (6 rows) or 4 (3 rows). Equals the length of `fields`.
    - **`printings[].drift.driftWarning.fields`**: array of strings. **`printings[].drift.driftWarning.fields[]`**: the drifted field names (power 9, hp 9, rarity 4, type 3, cost 3, aspects 2 across the 9 warnings).
- **Interacts with** (whole section): `cost`, `power`, `hp`, `type`, `rarity`, `aspects` in the official list, which supply the `official` side of every drift entry.

## Correction

One row of `tcg_corrections` (schema.ts:1025-1038); the file is an array and each element, path `$[]`, is one row. Each row is one committed rule rewriting one field of one TCGplayer listing so it lines up with the official printing. "Before" is TCGplayer's text; "after" is the official value. Nothing is hand-edited: each row names the rule that did it.

- **`$[].id`**: integer, `19679`. The row id; unique.
- **`$[].import_id`**: integer, `43` on all 1,038 rows. The import that applied it.
- **`$[].product_id`**: integer, `594176`. The TCGplayer product; 977 distinct, so some products carry two corrections. Joins to `printings[].product_id`.
- **`$[].seq`**: integer, `0` (977 rows) or `1` (61 rows). The order of this correction within the product (`conform/conform.ts:179`). A product with `seq` 1 had two rules fire.
- **`$[].rule_id`**: string, one of nine (`price.schema.ts:46`), listed in the order the rules run. Counts in import 43:
  - `promo-group` (606): a promo group's own abbreviation (such as `SOR-WPP`) is rewritten to the official set code (`conform/rules.ts:171`). Strategic value: attaches a promo price to the right set.
  - `combo-base` (332): `priceSource` changes from `direct` to `combo` for a card-plus-token listing (rules.ts:172).
  - `group-set` (6): the group names a set directly; `expansion` becomes that set (rules.ts:173). Example: before empty, after `GG`.
  - `exclusive-set` (2): a variant suffix names a different set than the group (rules.ts:174). Example: `ASH` becomes `CST` (Costco Exclusive).
  - `token-number` (2): a token listed as `T01` is mapped to the one same-titled token at that number (rules.ts:179-182).
  - `title-drift` (26): a TCGplayer title typo within edit distance 2 of the official title (`TITLE_DRIFT_MAX_DISTANCE`, rules.ts:4, 193-199). Example: `Jaunty Light Frieghter` becomes `Jaunty Light Freighter`.
  - `number-shift` (5): TCGplayer lists the number one off; the neighbour is the single exact match (rules.ts:202-206).
  - `promo-number` (55): a labelled promo listing sits up to 20 numbers from its printing (`PROMO_NUMBER_MAX_SHIFT`, rules.ts:74, 218-227).
  - `verified-listing` (4): hand-checked exceptions in a committed table (`VERIFIED_LISTINGS`, rules.ts:105-113), each applying only while the listing still has the verified name and number.
  - Strategic value: the audit trail. A price you trust is a price whose rewrites you can read.
- **`$[].field`**: string, one of expansion 614, priceSource 332, number 66, title 26. Which attribute the rule changed.
- **`$[].before`**: string, `"SOR-WPP"`, `"direct"`, `"113"`. 46 distinct values. TCGplayer's value, always stored as text (`schema.ts:1033`).
- **`$[].after`**: string, `"SOR"`, `"combo"`, `"114"`. 81 distinct values. The official value.
- **Interacts with**: `printings[].applied_rules` (same rule ids; per-product rule order equals `seq` order), `import.counts.byRule` (rule counts equal these rows' counts: 606, 332, 55, 26, 6, 5, 4, 2, 2).

## Quarantine

One row of `tcg_quarantine` (schema.ts:1042-1056); the file is an array. A listing too ambiguous or odd to price safely: it receives no price, and it is listed as a work queue for new rules.

- **`$[].id`**: integer, `6242`. The row id.
- **`$[].import_id`**: integer, `43` on all 122 rows.
- **`$[].product_id`**: integer, `592165`. The TCGplayer product (122 distinct). Never also in `printings[]`.
- **`$[].group_id`**: integer, `24387`. The TCGplayer group (13 distinct in this file; 24387 holds 42 rows and 24897 holds 40).
- **`$[].product_name`**: string, `"Senator Chuchi - Voice for the Voiceless (Serialized) (Rose Gold)"`. The TCGplayer listing title, with its finish and tier suffixes. Strategic value: lets you identify the card by eye.
- **`$[].number`**: string, `"1125"`, `"T01 // T02"`. TCGplayer's card number text; 90 distinct values. Interacts with: the number parser; `"T01 // T02"` is a two-token combo it cannot parse (`unparseable-number`).
- **`$[].variant`**: string or null: null 59, standard 23, standard-foil 20, promo 18, hyperspace 1, showcase 1. The variant the classifier read from the listing suffix before it quarantined; null if it could not read one.
- **`$[].reason`**: string, one of five seen (the code defines seven, `price.schema.ts:64`; `ambiguous` and `unmapped-group` have zero rows in import 43): unknown-variant-suffix 52, no-candidate 44, duplicate-claim 12, unparseable-number 7, field-disagreement 7. Strategic value: tells you what rule or data is missing: `unknown-variant-suffix` means a new finish name, `no-candidate` means no official printing exists at that number (a new set or promo not yet in the official list), `duplicate-claim` means two direct listings claim one printing and neither is trusted (`conform/conform.ts:172-176`), `field-disagreement` means a candidate exists but its identity (title or Base-versus-non-Base) disagrees.
- **`$[].candidate_card_ids`**: array of strings. **`$[].candidate_card_ids[]`**: an official `serialCode` the listing might have meant (`"p26780050"`, `"04020277"`). Empty on 103 rows; 19 entries across 13 distinct ids. Strategic value: the shortlist for a human to resolve. Interacts with: the official `serialCode`.
- **Interacts with** (whole section): `import.counts.quarantined` and `byReason`; the official list (`candidate_card_ids` must exist there).

## Set 7 to 9 additions: A Lawless Time, Ashes of the Empire, Homeworlds

The rules digest dates from August 2025 and predates LAW (A Lawless Time), ASH (Ashes of the Empire) and HMW (Homeworlds). This section covers every value that appears only in those sets, found by filtering the inventory by expansion code (`tools/newvals.mjs` in the scratchpad). Sources are official articles on starwarsunlimited.com, read through the site's article API (https://admin.starwarsunlimited.com/api/articles). The official comprehensive rules document itself was not fetched, so rules wording below is the article's wording or the card's own text in the data.

Values that appear only in LAW, ASH or HMW printings:
- Keyword `Fortify` (48 printings, all HMW: 45 Upgrades and 3 Leaders). Official: "the new Fortify keyword ... instructs you to attach the upgrade to your base instead of a unit, a Star Wars: Unlimited first" (https://starwarsunlimited.com/articles/homeworlds). Grand Moff Tarkin and the Death Star ignore the aspect penalty on Fortify upgrades you play (same article; the card text in the data agrees: "Ignore the aspect penalties on upgrades with Fortify you play"). Strategic value: a Fortify upgrade protects or heals your base instead of boosting a unit, so it is a defensive and tempo tool. Interacts with: the base's HP (what it protects), the `Fortification` trait, and the aspect penalty. Vice Admiral Rampart can stop one of your Fortify upgrades from being defeated (https://starwarsunlimited.com/articles/defend-and-destroy).
- Trait `Fortification` (42 printings, all HMW Upgrades). Official: other cards reference "a Fortification upgrade" (The Tarkin Doctrine, in https://starwarsunlimited.com/articles/homeworlds). Marks an upgrade that sits on a base. Interacts with: Fortify (every Fortification in the data also has Fortify) and with cards that trigger when you play one.
- Expansion codes `LAW` (907 printings), `LAWP` (40), `ASH` (931), `ASHP` (40), `HMW` (954), `HMWP` (40). The P-suffixed codes are the Weekly Play sets for that set. HMW is the ninth set, released 2026-10-09 (https://starwarsunlimited.com/products/set-9-homeworlds, "Releasing October 9th, 2026"). Their Premier legality is in [swu-formats.md](https://github.com/LampaGJ/mault/blob/feature/swu-support/docs/concepts/swu-formats.md). Promo reprints of LAW, ASH and HMW cards sit in promo expansions such as P26, C26 and CST.

Values that first appear in these sets but also appear in a promo expansion, so they do not pass the "only in" filter:
- Keyword `Support` (122 printings: ASH 108, ASHP 8, plus 1 CST and 5 P26 reprints). First appears in ASH. Card text in the data: "When you play this unit, you may attack with another unit. It gains this unit's other abilities for this attack." (Grand Admiral Thrawn). Official: the keyword lets units work together, and its power is "granting the supporting unit's abilities to the attacking unit" (https://starwarsunlimited.com/articles/insights-to-ashes). Strategic value: any unit can become a threat, so attack more and trade more. Interacts with: attacks, readiness (the supporting unit is not exhausted by it), and the supporter's other abilities and keywords.
- Trait `Musician` (9 printings, first in LAW: The Max Rebo Band and Max Rebo). Meaning not covered by any article read; from card text it is a trait that other cards can reference (unconfirmed).
- Type `Credit Token` (3 printings: two in LAW, one in P26). Official: "whenever you would pay resources ... you can defeat any number of Credit tokens you control to grant yourself a 1-resource discount for each Credit you defeat" (https://starwarsunlimited.com/articles/aspects-and-credits). Card text: "While paying resources, you may defeat this token. If you do, pay 1 resource less." Credits have null cost, power and HP. Strategic value: stored resource discount. Interacts with: cost, Smuggle and Exploit cost paths (unconfirmed which cost paths accept credits).
- Token titles (these are `title` values on token printings, not enum values): `Advantage` (Token Upgrade, ASH; power 1, HP 0; text "When attached unit's attack or defense ends: Defeat this upgrade."; official: temporary power boost, https://starwarsunlimited.com/articles/insights-to-ashes). `Mandalorian` (Token Unit, ASH; 2/2; "Shielded (When you create this token, give a Shield token to it.)"; official: Paz Vizsla leaves two Mandalorian tokens when defeated, https://starwarsunlimited.com/articles/welcome-to-ashes). `Beast` (Token Unit, HMW; 3/3, "the largest we've seen", https://starwarsunlimited.com/articles/homeworlds). `Weakness` (Token Upgrade, HMW; "functioning essentially as the inverse of the classic Experience token", same article). In the raw pages Weakness has `upgradePower` -1 and `upgradeHp` -1, so it is a -1/-1 modifier (confirmed from the API; the official article calls it the inverse of Experience).
- Arena: the raw pages carry `arenas` (Ground 5,731 printings, Space 1,841); see "Raw API page". Official: Homeworlds' Death Star is "the game's first true 'space leader'", a leader unit that deploys into the space arena (https://starwarsunlimited.com/articles/defend-and-destroy); in the data the three Space Leaders are Grand Moff Tarkin.
- Base traits: Homeworlds' Common bases carry the traits Tatooine, Naboo, Endor and Kashyyyk, and cards refer to them (https://starwarsunlimited.com/articles/homeworlds). Neither the exported data nor the raw pages carry traits on any Base (all 262 raw Bases have an empty `traits` list), so these values do not appear in the files (unconfirmed why the API omits them).
- No new aspect, rarity, card type or variant name appears only in LAW, ASH or HMW. The six aspects, five rarities, nine types and 58 variant names were all already present before them. HMW carries Carbonite Edition booster-pack variants, which the official page says include "Carbonite-exclusive Prestige variants" (https://starwarsunlimited.com/products/set-9-homeworlds); in the data these are the existing Prestige variant names.

## How the files join

- Official `printings[].serialCode` equals price `printings[].card_id`. One card id can have several price rows (one per TCGplayer product, notably combo listings).
- Price `printings[].product_id` joins `$[].product_id` in the corrections file (one-to-many through `seq`) and is disjoint from the quarantine file's `product_id`.
- Quarantine `candidate_card_ids[]` points back to official `serialCode`.
- Every price, correction and quarantine row has `import_id`, equal to `import.id` (43). One import is a self-contained snapshot; older imports keep their `price_points` but have their detail rows pruned to the last 30 (schema.ts:966-968).
- `group_id` is shared between price rows and quarantine rows (TCGplayer's group), and is not an official field.
- Coverage in import 43: 10,211 official printings; 8,654 distinct priced `card_id`s (so about 1,557 printings have no price row); 122 quarantined listings.

## Gaps and uncertain meanings

- `deployBox` and `epicAction` on non-Leaders, `hp` clustering, and the Special rarity tier are read from data (marked inferred above).
- The digest does not define Fortify, Plot or Support. Fortify and Support come from official articles (see "Set 7 to 9 additions"); Plot comes from the reminder text on its cards.
- `arenas` is absent from the trimmed exports; its values come from the raw pages.
- The `-dirty` meaning of `code_commit` is inferred from the suffix.
