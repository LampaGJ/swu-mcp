/**
 * @displayName forceteki single-thread match player
 * @strategicPurpose Play a few seeded matches in this thread with full decision records, for reading a game or
 * tracing an engine error to its decision (#110, #142).
 * @tacticalObjective The batch runner with this thread only, full records and one game by default; `--trace` prints
 * the stack of any error with the decision index it struck at.
 *
 * Usage: tsx scripts/sims/play.ts --deck1 <json> --deck2 <json> [--games N] [--seed S] [--out <records.jsonl>] [--trace]
 */
import { isMain } from "../bench/code-commit.js";
import { main } from "./run-batch.js";

if (isMain(import.meta.url)) await main(process.argv.slice(2), { workers: "0", record: "full", games: "1" });
