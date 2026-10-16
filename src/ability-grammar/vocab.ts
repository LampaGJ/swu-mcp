import { compareCodePoints } from "./deps.js";

export const GRAMMAR_VERSION = 1;

export const KEYWORDS = [
  "Ambush", "Bounty", "Coordinate", "Exploit", "Fortify", "Grit", "Hidden", "Overwhelm",
  "Piloting", "Plot", "Raid", "Restore", "Saboteur", "Sentinel", "Shielded", "Smuggle", "Support",
] as const;

export const TOKENS = [
  "Clone Trooper", "Battle Droid", "TIE Fighter", "X-Wing", "Advantage", "Beast", "Credit",
  "Experience", "Mandalorian", "Shield", "Spy", "Weakness", "Force",
] as const;

export const ASPECTS = ["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"] as const;

export const TRAIT_WORDS = [
  "Armor", "Bounty Hunter", "Capital Ship", "Clone", "Condition", "Creature", "Droid", "Ewok", "Fighter",
  "First Order", "Force", "Fortification", "Fringe", "Gambit", "Gungan", "Hutt", "Imperial", "Inquisitor",
  "Item", "Jawa", "Jedi", "Kaminoan", "Law", "Learned", "Lightsaber", "Mandalorian", "Modification",
  "Musician", "Naboo", "New Republic", "Night", "Nihil", "Official", "Pilot", "Plan", "Rebel", "Republic",
  "Resistance", "Separatist", "Sith", "Spectre", "Speeder", "Supply", "Tactic", "Tank", "Transport", "Trick",
  "Trooper", "Tusken", "Twi'lek", "Undead", "Underworld", "Vehicle", "Walker", "Weapon", "Wookiee",
] as const;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest-first regex alternation, so "Bounty Hunter" wins over "Bounty". */
export function alternation(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length || compareCodePoints(a, b))
    .map(escapeRegex)
    .join("|");
}

export const KW_ALT = alternation(KEYWORDS);
export const TOKEN_ALT = alternation(TOKENS);
