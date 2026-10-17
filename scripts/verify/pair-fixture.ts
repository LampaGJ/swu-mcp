/**
 * Evidence packets for the labelled pairing fixture (LampaGJ/swu-mcp#15). A deterministic stratified sample of 200
 * (pair, complementarity row) units is cut into 8 packets of 25 for model judging; scripts/verify/pair-fixture-pin.ts
 * then pins the captured verdicts as data/fixtures/pairs-v1.json.
 *
 * Usage: tsx scripts/verify/pair-fixture.ts [--originals <dir>] [--run <dir>] [--out <dir>] [--seed <s>] [--total <n>] [--floor <n>]
 *   --seed  default: pair-fixture-v1
 *   --out   default: <repo>/tmp/pair-fixture   (packets go to <out>/packets)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { buildRecordSchema } from "../lib/build-record.js";
import { DEFAULT_ORIGINALS_ROOT, newestDatedDir } from "../lib/originals.js";
import { PAIRINGS_INSTRUCTIONS, buildIndex, loadInputs, orderBySeed, pairingItemBuilder, serialize, type Packet } from "./sample.js";
import { REPO_ROOT } from "../../src/paths.js";


export const FIXTURE_SEED = "pair-fixture-v1";
export const FIXTURE_TOTAL = 200;
export const FIXTURE_FLOOR = 3;
export const PACKET_SIZE = 25;

type Rec = Record<string, unknown>;

export interface PairUnit {
  id: string;
  offer: string;
  want: string;
  row: string;
  pair: Rec;
}

export const unitId = (offer: string, want: string, row: string): string => `${offer}>${want}:${row}`;

export function parseUnitId(id: string): { offer: string; want: string; row: string } {
  const match = /^([^>]+)>([^:]+):(.+)$/.exec(id);
  if (match === null) throw new Error(`malformed pair id: ${id}`);
  return { offer: match[1] as string, want: match[2] as string, row: match[3] as string };
}

export const rowIdsOf = (rows: string): string[] => rows.split("|").map((row) => row.split(":")[0] as string);

/** One unit per (pair, row): a pair that several rows claim is judged once per row. */
export function pairUnits(pairs: readonly Rec[]): PairUnit[] {
  const units = new Map<string, PairUnit>();
  for (const pair of pairs) {
    const offer = String(pair.cardA);
    const want = String(pair.cardB);
    for (const row of rowIdsOf(String(pair.rows))) {
      const id = unitId(offer, want, row);
      if (!units.has(id)) units.set(id, { id, offer, want, row, pair });
    }
  }
  return [...units.values()];
}

/**
 * Per-row sample size: proportional to the row's pair count, at least `floor` for a row with at least `floor` pairs,
 * at most the row's pair count; the proportional remainder goes to the largest fractional parts (ties by row id).
 */
export function allocate(counts: ReadonlyMap<string, number>, total: number, floor: number): Map<string, number> {
  const fixed = new Map<string, number>();
  let free = [...counts.keys()].sort(compareCodePoints);
  for (;;) {
    const budget = total - [...fixed.values()].reduce((a, b) => a + b, 0);
    const mass = free.reduce((n, row) => n + (counts.get(row) as number), 0);
    const share = (row: string): number => (mass === 0 ? 0 : ((counts.get(row) as number) * budget) / mass);
    const clamp = free.find((row) => {
      const count = counts.get(row) as number;
      return (count >= floor && share(row) < floor) || share(row) > count;
    });
    if (clamp === undefined) break;
    const count = counts.get(clamp) as number;
    fixed.set(clamp, share(clamp) > count ? count : floor);
    free = free.filter((row) => row !== clamp);
  }
  const budget = total - [...fixed.values()].reduce((a, b) => a + b, 0);
  const mass = free.reduce((n, row) => n + (counts.get(row) as number), 0);
  const out = new Map(fixed);
  const parts = free.map((row) => {
    const exact = mass === 0 ? 0 : ((counts.get(row) as number) * budget) / mass;
    return { row, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = budget - parts.reduce((n, p) => n + p.base, 0);
  const byFrac = [...parts].sort((a, b) => b.frac - a.frac || compareCodePoints(a.row, b.row));
  const bump = new Set<string>();
  for (const p of byFrac) {
    if (left <= 0) break;
    if (p.base < (counts.get(p.row) as number)) {
      bump.add(p.row);
      left -= 1;
    }
  }
  for (const p of parts) out.set(p.row, p.base + (bump.has(p.row) ? 1 : 0));
  return out;
}

export function selectFixtureUnits(units: readonly PairUnit[], seed: string, total = FIXTURE_TOTAL, floor = FIXTURE_FLOOR): PairUnit[] {
  const byRow = new Map<string, PairUnit[]>();
  for (const unit of units) byRow.set(unit.row, [...(byRow.get(unit.row) ?? []), unit]);
  const counts = new Map([...byRow].map(([row, list]) => [row, list.length]));
  const quotas = allocate(counts, Math.min(total, units.length), floor);
  const chosen: PairUnit[] = [];
  for (const [row, list] of byRow) chosen.push(...orderBySeed(list, seed, (u) => u.id).slice(0, quotas.get(row) ?? 0));
  return orderBySeed(chosen, seed, (u) => u.id);
}

export function buildFixturePackets(inputs: Parameters<typeof pairingItemBuilder>[0], seed: string, total = FIXTURE_TOTAL, floor = FIXTURE_FLOOR): { packets: Packet[]; selected: PairUnit[] } {
  const selected = selectFixtureUnits(pairUnits(inputs.pairs), seed, total, floor);
  const itemOf = pairingItemBuilder(inputs);
  const items = selected.map((unit) => ({ id: unit.id, row: unit.row, ...itemOf(unit.pair) }));
  const packets: Packet[] = [];
  for (let i = 0; i * PACKET_SIZE < items.length; i += 1) {
    const slice = items.slice(i * PACKET_SIZE, (i + 1) * PACKET_SIZE);
    const instructions = `${PAIRINGS_INSTRUCTIONS} Judge the row named in \`row\` (the item id ends with it); the pair may carry other rows too.`;
    packets.push({ packet: `p${i + 1}`, packetType: "pairings", seed, itemCount: slice.length, whatToCheck: instructions, items: slice });
  }
  return { packets, selected };
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, run: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, total: { type: "string" }, floor: { type: "string" } } });
  const originalsDir = path.resolve(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT, "originals"));
  const runDir = path.resolve(values.run ?? newestDatedDir(path.join(REPO_ROOT, "data/runs"), "run"));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/pair-fixture"));
  const seed = values.seed ?? FIXTURE_SEED;
  const build = buildRecordSchema.parse(JSON.parse(readFileSync(path.join(runDir, "build.json"), "utf8")));
  const inputs = loadInputs({ originalsDir, runDir });
  const allUnits = pairUnits(inputs.pairs);
  const { packets, selected } = buildFixturePackets(inputs, seed, Number(values.total ?? FIXTURE_TOTAL), Number(values.floor ?? FIXTURE_FLOOR));
  const packetsDir = path.join(outDir, "packets");
  mkdirSync(packetsDir, { recursive: true });
  const sizes = new Map<string, number>();
  for (const packet of packets) {
    const text = serialize(packet);
    sizes.set(packet.packet, Buffer.byteLength(text));
    writeFileSync(path.join(packetsDir, `${packet.packet}.json`), text);
  }
  const perRow: Record<string, { units: number; sampled: number }> = {};
  for (const unit of allUnits) (perRow[unit.row] ??= { units: 0, sampled: 0 }).units += 1;
  for (const unit of selected) (perRow[unit.row] as { sampled: number }).sampled += 1;
  const index = { ...buildIndex(packets, seed, sizes), sourceRun: { date: build.date, buildHash: build.buildHash }, perRow: Object.fromEntries(Object.entries(perRow).sort(([a], [b]) => compareCodePoints(a, b))) };
  writeFileSync(path.join(outDir, "index.json"), serialize(index));
  console.log(`${selected.length} items in ${packets.length} packets, seed ${seed}, run ${build.date}, wrote ${outDir}`);
  for (const [row, n] of Object.entries(index.perRow)) console.log(`${row}: ${n.sampled} of ${n.units}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
