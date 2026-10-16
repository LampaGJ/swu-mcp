// Ported from mault packages/server/src/lib/adapters/swu/llm-package-readme.ts.
import { CDN_PREFIX, DROPPED_FIELDS, GAMEPLAY_FIELDS, INDEX_FACETS } from "./llm-flatten.js";

export interface ReadmeContext {
  packageDate: string;
  raw: { label: string; startedAt: string; finishedAt: string; pageCount: number; baseUrl: string };
  priceImport: { id: number; startedAt: string | null; finishedAt: string | null };
  counts: {
    printings: number;
    logicalCards: number;
    allLogicalCards: number;
    oldSetsOnly: number;
    promoOnly: number;
    printingsFolded: number;
    priceRows: number;
    corrections: number;
    quarantine: number;
    snapshots: number;
    nonStandardCanonical: number;
    multiRootComponents: number;
    nameRows: number;
  };
  image: { sizeKeys: ReadonlyMap<string, ReadonlySet<string>>; unfit: number; doubleSlash: number };
  mismatchesByField: ReadonlyMap<string, number>;
  mismatchTotal: number;
  facets: ReadonlyMap<string, { values: number; missingDefinitions: number }>;
  docs: readonly { name: string; purpose: string }[];
  tokenNote: string;
  originalsPath: string;
}

export function buildReadme(ctx: ReadmeContext): string {
  const sizeKeyLines = [...ctx.image.sizeKeys.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, keys]) => `- ${field}: ${[...keys].sort().join(", ")}`);
  const mismatchLines = [...ctx.mismatchesByField.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([field, count]) => `- ${field}: ${count}`);
  const facetLines = INDEX_FACETS.map((facet) => {
    const stats = ctx.facets.get(facet);
    return `- ${facet}: ${stats?.values ?? 0} values; values without a glossary definition: ${stats?.missingDefinitions ?? 0}`;
  });
  const docLines = ctx.docs.map((doc) => `- docs/${doc.name}: ${doc.purpose}`);
  const mismatchSection =
    ctx.mismatchTotal === 0
      ? "Every folded printing matched its canonical printing on all gameplay fields."
      : `${ctx.mismatchTotal} field-level differences were found. Per field (kept cards only):\n${mismatchLines.join("\n")}\n\nThe cards file keeps the canonical printing's values. Every difference is listed in llm/gameplay-mismatches.toon.`;

  return `# Star Wars: Unlimited data package, ${ctx.packageDate}

## TL;DR

The folder llm/ in this zip holds the ${ctx.counts.logicalCards} logical cards that have a printing in Jump to Lightspeed or a later set (or in one of those sets' Weekly Play sets), one row per card, plus lookup indexes, built for feeding to a language model. ${ctx.tokenNote} The originals of all sets (every raw page, snapshot and price file) are not in this zip; they stay on the maintainer's machine at ${ctx.originalsPath}. Start with llm/cards.toon.

## Sources

- Official card list: ${ctx.raw.baseUrl}, raw cache run "${ctx.raw.label}", downloaded ${ctx.raw.startedAt} to ${ctx.raw.finishedAt}, ${ctx.raw.pageCount} pages, ${ctx.counts.printings} printings.
- TCGplayer prices: conformed price import number ${ctx.priceImport.id}, started ${ctx.priceImport.startedAt ?? "unknown"}, finished ${ctx.priceImport.finishedAt ?? "unknown"}.
- Catalogue snapshots: ${ctx.counts.snapshots} files, one per earlier download of the card list.

## Files

- README.md: this guide.
- replay.json: the hash of every input, the code commit, and the hash of every file in llm/. Run the script again on the same inputs and these hashes must match.
- llm/cards.toon: one row per logical card. Start here.
- llm/gameplay-mismatches.toon: each place where a folded printing disagrees with its canonical printing.
- llm/index/aspect.toon, trait.toon, keyword.toon, type.toon, arena.toon, rarity.toon, expansion.toon, variant.toon: one row per value of that facet, with the number of cards, a definition, and the card keys.
- llm/index/names.toon: ${ctx.counts.nameRows} rows mapping a card title and subtitle to card keys.
${docLines.join("\n")}

### Kept locally (not in this zip)

These files live at ${ctx.originalsPath}, cover all sets, and replay.json holds the hash of every one of them.

- swu-cards/raw-pages/page-NNNN.json: one file per page of the official card list, byte-identical to what the server received. Nothing is removed or reformatted.
- swu-cards/raw-pages/manifest.json: the download record for those pages (URL, status, size and sha256 of each page).
- swu-cards/catalogue-snapshots/: earlier parsed copies of the card list, named by their own sha256. They are what the catalogue backfill reads.
- tcgplayer-prices/price-import.json: the one price import row (when it ran, input hashes, counts).
- tcgplayer-prices/printings.json: ${ctx.counts.priceRows} priced printings as stored, sorted by card_id then product_id.
- tcgplayer-prices/corrections.json: ${ctx.counts.corrections} corrections the conformance step applied to TCGplayer data, sorted by product_id then seq.
- tcgplayer-prices/quarantine.json: ${ctx.counts.quarantine} TCGplayer products that could not be matched to a card, sorted by product_id then id.

TOON is a compact text format for tables: a header line names the columns, then one line per row. Spec and parsers: https://github.com/toon-format/toon

## Logical cards and printings

The game prints one card many times: standard, foil, Hyperspace, Showcase, Prestige, promos, Weekly Play, convention, and reprints in later sets. The official list has one record per printing (${ctx.counts.printings}). Across all sets there are ${ctx.counts.allLogicalCards} logical cards, and ${ctx.counts.printingsFolded} other printings fold into them. The llm/ copy keeps one row per logical card, limited to current sets (next paragraph).

Set filter: a card is kept only if at least one of its printings is in Jump to Lightspeed (set 4) or any later set, or in that set's Weekly Play set (code ending in P, such as JTLP). This follows the release-order table in packages/shared/src/adapters/swu/set-rotation.ts, so a new set is included once it is added there. It matches Premier legality: the year-1 sets (SOR, SHD, TWI) rotated out when LAW released. Excluded: ${ctx.counts.oldSetsOnly} cards printed only in older sets, and ${ctx.counts.promoOnly} cards printed only in promo, convention, judge, gift-box or Intro Battle sets. A kept card's sets, firstSet, printingCount and variants columns and its canonical printing still consider all of its printings, including old ones. The local originals hold every set.

Printings are grouped through the variantOf and reprintOf links in the official data. The canonical printing is the one that links to no other printing. If a group has no such printing, or more than one (${ctx.counts.multiRootComponents} groups), the earliest set by release order wins (packages/shared/src/adapters/swu/set-rotation.ts), then the lowest serialCode. ${ctx.counts.nonStandardCanonical} cards have a canonical printing that is not a Standard printing.

Each card row has these columns, in order: cardKey (the canonical printing's serialCode), then the gameplay fields (${GAMEPLAY_FIELDS.join(", ")}), then the canonical printing's other fields (rarity, expansion, cardNumber, cardCount, artist, art columns, flags), then the summary columns: sets (every expansion code the card appears in, joined by "|", oldest first), firstSet (the earliest set by release order, so reprints of older cards are visible), printingCount, variants (every distinct variant name, joined by "|"), priceNormal and priceFoil (the canonical printing's prices from the price import, empty when it is not priced).

Gameplay check: after ignoring extra whitespace and the order of aspects, traits and similar lists, a printing that differs from its canonical printing is a mismatch. ${mismatchSection}

## How the files join

- cardKey in llm/cards.toon, the card_id column in the local tcgplayer-prices/printings.json, and the serialCode in the raw pages are the same identifier for the canonical printing.
- product_id joins the three TCGplayer files (printings, corrections, quarantine).
- Every key listed in an index file is a cardKey in llm/cards.toon. Split the "|"-joined list on "|".
- names.toon maps title and subtitle to cardKeys. Two different cards can share a title, so it can list several keys.
- sets in the cards file is a list of expansion codes. Facet index expansion.toon lists the cards per code.

## Index files

Each file under llm/index/ has the columns value, cards (how many logical cards have the value), definition, and cardKeys (sorted by code point, joined by "|"). The indexes count logical cards only. Aspect values come from the aspects column (aspectDuplicates is not indexed). Type covers type and type2. Definitions come from docs/swu-glossary.json. A value the glossary lacks has an empty definition. Per facet:
${facetLines.join("\n")}

## Images

Image columns (artFront, artBack, artThumbnail) hold only the unique file stem. Rebuild a URL as ${CDN_PREFIX}[<size>_]<stem>. Use no size prefix for the original upload. Size keys seen in the data, per image column:
${sizeKeyLines.join("\n")}

A stem that starts with "/" means the official URL has a second slash after the host: ${CDN_PREFIX}/[<size>_]<stem without the leading slash>. ${ctx.image.doubleSlash} images use that form. ${ctx.image.unfit} image cells did not fit the pattern (stems disagreed between sizes, or a URL was shaped differently); those cells keep the full URL.

## Fields left out of llm/

${DROPPED_FIELDS.map((field) => `- ${field}`).join("\n")}

Relations become names joined by "|" (expansion uses its code). variantOf and reprintOf are used to fold printings and are not repeated in the cards file. Everything is still in the local originals.

## Replay

From the repository, run:

    pnpm export:package --originals <originals directory>

The script verifies every raw page against the manifest (sha256 and byte length), rebuilds llm/ from the pages and the price files in the originals directory, and writes replay.json. Compare its inputs and outputs with this package's replay.json. The price files are import ${ctx.priceImport.id}. The same originals give byte-identical llm/ files.
`;
}
