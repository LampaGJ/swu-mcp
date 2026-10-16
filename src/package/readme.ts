import { CDN_PREFIX } from "../swu/llm-flatten.js";

/**
 * @displayName Reader zip README builder
 * @strategicPurpose The entry point of the reader zip (LampaGJ/swu-mcp#7): tells a model what each file is for,
 * what to load first and where the data is weak, so it does not read the audit material or trust a number past
 * what supports it.
 * @tacticalObjective Pure text assembly from counts, file sizes and token counts measured by the caller.
 */

export interface PackagedFile {
  path: string;
  bytes: number;
  /** o200k token count (a proxy), null for files that are not meant to be read as text. */
  tokens: number | null;
}

export interface LeanReadmeContext {
  packageDate: string;
  buildHash: string;
  sourcesBlock: string;
  imageSizeKeys: string;
  counts: {
    cards: number;
    scored: number;
    clusters: number;
    trioShapes: number;
    pairingCards: number;
    fungibleClasses: number;
    rulings: number;
    vectors: number;
  };
  params: { pairsPerCard: number; triosPerShape: number; trioMaxCost: number; neighbours: number; trioFanout: number; vectorDims: number; vectorScale: number };
  droppedColumns: readonly string[];
  files: readonly PackagedFile[];
  llmTokens: number;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

export function buildLeanReadme(ctx: LeanReadmeContext): string {
  const tokenOf = (file: string): string => {
    const hit = ctx.files.find((candidate) => candidate.path === file);
    return hit === undefined || hit.tokens === null ? `${fmt(hit?.bytes ?? 0)} bytes` : `${fmt(hit.tokens)} tokens`;
  };
  const c = ctx.counts;
  return `# Star Wars: Unlimited data for language models, ${ctx.packageDate}

## TL;DR

${fmt(c.cards)} cards, one row per card, with a play-calibrated score, a role cluster, and lookup tables for similar cards, synergy pairs, three-card combos and interchangeable cards. Everything a reader loads is in llm/ (about ${fmt(ctx.llmTokens)} tokens in all; each file is listed with its size below, so load only what the question needs). optional/ holds numeric vectors. audit/ is for checking the build and a reader can skip it. Every number comes from deterministic code over pinned inputs; no model produced a score.

## Load first

1. llm/cards.toon (${tokenOf("llm/cards.toon")}): the card table. Every other file joins to it by cardKey.
2. llm/legend.toon (${tokenOf("llm/legend.toon")}): what each aspect, trait, keyword and other facet value means, what each pairing reason and trio shape means. Definitions live here once and nowhere else in llm/.
3. Then only the file that answers the question (next section).

TOON is a compact text format for tables: a header line names the columns, then one line per row. Spec and parsers: https://github.com/toon-format/toon

## Files

- README.md: this guide.
- llm/cards.toon: one row per logical card (a card with all its reprints folded together). Columns as in the card data field guide (docs/swu-card-data-fields.md), plus three added at the end: playCalibrated (score fitted to how often the card appears in Premier decks, rank-meaningful only), total (designer-style score, comparable only inside one card type), cluster (id of the card's role cluster, see clusters.toon). Empty means not scored.
- llm/legend.toon (${tokenOf("llm/legend.toon")}): columns kind, id, definition.
- llm/index/aspect.toon, trait.toon, keyword.toon, type.toon, arena.toon, rarity.toon, expansion.toon, variant.toon: one row per facet value, with columns value, cards (count) and cardKeys (joined by "|"). No definitions here; look the value up in the legend.
- llm/index/names.toon (${tokenOf("llm/index/names.toon")}): title and subtitle to cardKeys.
- llm/index/similar.toon (${tokenOf("llm/index/similar.toon")}): columns cardKey, neighbours. Cards whose ability text reads alike. Each neighbour is cardKey:cosine, cosine to two decimals, best first, the best ${ctx.params.neighbours} (the similar_cards tool of the MCP server gives up to 10), only cosine 0.75 or higher. Cards with no ability text have no row.
- llm/index/kin.toon (${tokenOf("llm/index/kin.toon")}): same layout. Cards that do the same thing under different words: names, traits, keywords, aspects, arenas and numbers are masked before comparing. The best ${ctx.params.neighbours}, no cosine floor.
- llm/index/clusters.toon (${tokenOf("llm/index/clusters.toon")}): columns id, size, label. ${c.clusters} role clusters (k-means, fixed seed). The label lists the most common words, keywords and types in the cluster with the share of members that carry them. A card's cluster id is the cluster column in cards.toon.
- llm/index/pairings.toon (${tokenOf("llm/index/pairings.toon")}): columns cardKey, pairs. Top ${ctx.params.pairsPerCard} synergy partners per card (${fmt(c.pairingCards)} cards have at least one). Each pair is "<direction><partnerKey> <reasonId> <score>", pairs joined by "|". Direction ">" means the partner is a payoff this card feeds. Direction "<" means the partner feeds this card. reasonId is explained in the legend (kind pairing-reason). Pairs that share only a trait are left out.
- llm/index/trios.toon (${tokenOf("llm/index/trios.toon")}): the best ${ctx.params.triosPerShape} three-card combos for each of ${ctx.counts.trioShapes} shapes (kind trio-shape in the legend) with total cost ${ctx.params.trioMaxCost} or less. Columns cardA, cardB, cardC, shape, totalCost, aspectPair (the cheapest leader and base aspects that cover the three), penalty (extra resources the cheapest cover still costs), score, reasons (the pair rule behind each link, by reason id as in the legend; links separated by " | " in card order).
- llm/index/fungible.toon (${tokenOf("llm/index/fungible.toon")}): ${fmt(c.fungibleClasses)} role classes that have at least two members. A class is cards that do the same job (same offer or want tag, card type, timing, size of effect and cost band). Columns role, size, byAspect. byAspect groups the members by aspect icons as "Aspect+Aspect=key|key;Aspect=key". Use it to swap a card for another aspect.
- llm/rules/core-primer.md (${tokenOf("llm/rules/core-primer.md")}): verbatim core text of the official Comprehensive Rules, each line prefixed by its section id. Read it before answering a rules question.
- llm/rules/card-rulings.toon (${tokenOf("llm/rules/card-rulings.toon")}): ${fmt(c.rulings)} dated official rulings. Columns cardKey, date, text.
- optional/vectors.toon: ${fmt(c.vectors)} embedding vectors, for readers who run their own similarity search. Not text for a model to read. Decode recipe below.
- audit/: build records, JSON Schemas and the list of printing disagreements. Skip it unless you are checking the build.
- docs/: swu-card-data-fields.md (what every card field means and why it matters), swu-rubric-summary.md (how the scores are built and where they are weak).

## How the files join

- cardKey is the key everywhere. It is the serial code of the card's canonical printing.
- Every key in an index, neighbour, pair, trio, fungible and vector row is a cardKey in llm/cards.toon.
- Facet values in the indexes match the "|"-joined values in the aspects, traits, keywords, arenas and sets columns of cards.toon.
- Reprints are folded: one row per card, not per printing. The sets, firstSet, printingCount and variants columns say where else it was printed.

## Images

Image columns hold only the file stem. Rebuild a URL as ${CDN_PREFIX}[<size>_]<stem>. Use no size prefix for the original upload. Size prefixes seen: ${ctx.imageSizeKeys}. A stem that starts with "/" means the official URL has a second slash after the host: ${CDN_PREFIX}/[<size>_]<stem without the leading slash>. A small image of a card is the same stem with the thumbnail prefix.

## Cards left out, columns left out

Only cards that have a printing in Jump to Lightspeed or a later set (or in that set's Weekly Play set) are here, which matches Premier legality. Cards printed only in older sets or only as promos are not. To keep llm/cards.toon small, these columns of the full table are not shipped: ${ctx.droppedColumns.join(", ")}. The image variants can be rebuilt from artFront with a size prefix; the rest are internal ids. The complete table is in the build that made this zip.

## Vectors

optional/vectors.toon has columns cardKey, v. v is base64url (no padding) of ${ctx.params.vectorDims} signed bytes. value[i] = int8[i] x ${ctx.params.vectorScale}. The vector is the first ${ctx.params.vectorDims} dimensions of the 768-dimension nomic-embed-text embedding of the card's ability text, renormalised to unit length before quantising. Compare two cards with the dot product divided by the two vector lengths. Cards with no ability text have no row.

## Honest limits

- The offers and wants tags behind pairings, trios and fungible classes come from a grammar plus a hand-reviewed table. Their precision has not been measured against a labelled test set. Treat a pair as a lead, not a verdict.
- Pairings keep the top ${ctx.params.pairsPerCard} per card. Trios search from the ${ctx.params.trioFanout} strongest links per card, so they are the best found, not every combo.
- playCalibrated is fitted to online Premier deck data (SWU Stats, three windows). It is rank-meaningful only. It is fitted to the same play data it is later compared with, so a gap between score and play is partly circular. Homeworlds (HMW) has under one week of play data and is outside the fit.
- total is a designer-style stat-efficiency score. It is comparable only inside one card type (unit with unit). It does not predict play.
- Prices (priceNormal, priceFoil) are US TCGplayer prices from one import. They follow rarity almost entirely, so cheap commons dominate any value per dollar ranking.
- similar and kin come from one embedding model run once and pinned. Cosines are only meaningful against each other inside the same file.
- Cluster labels are automatic word counts, not names. A cluster mixes cards; read the label as a hint.
- The Comprehensive Rules text is version 8.0. Whether a newer version exists is checked by hand (pnpm rules:check in the repository).

## Sources

${ctx.sourcesBlock}

## Replay

The build that made this zip has hash ${ctx.buildHash} (data/runs/${ctx.packageDate}/build.json in the repository, copy in audit/replay/build.json). audit/package.json lists the sha256 of every file in this zip. From the repository, \`pnpm build:data\` then \`pnpm package:zip\` rebuilds it.
`;
}
