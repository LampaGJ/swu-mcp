import sys; sys.path.insert(0, "/Volumes/Local Files/Projects/mault-train/swu-card-data/embed/scripts")
import json, re
from render import load, S, sha, clean
cards = load()
def split(f): return {p for c in cards for p in (c.get(f) or "").split("|") if p}
traits, kws, aspects = split("traits"), split("keywords"), split("aspects")
aspects |= {"Command", "Cunning", "Vigilance", "Aggression", "Villainy", "Heroism"}
names = {c["title"] for c in cards if "Token" not in c["type"]}
leaders_first = {c["title"].split(",")[0].split(" ")[0] for c in cards if c["type"] == "Leader"} | {c["title"].split(" ")[0] for c in cards if c["type"] == "Leader"}
names |= {n for n in leaders_first if len(n) > 3}
def alt(words): return "|".join(re.escape(w) for w in sorted(words, key=lambda w: (-len(w), w)))
RX = [
 (re.compile(r"\([^)]*\)"), ""),
 (re.compile(r"(?<![\w])(" + alt(names) + r")(?:'s)?(?![\w])"), "NAME"),
 (re.compile(r"\b(" + alt(traits) + r")\b"), "TRAIT"),
 (re.compile(r"\b(" + alt(kws) + r")\b"), "KEYWORD"),
 (re.compile(r"\b(" + alt(aspects) + r")\b"), "ASPECT"),
 (re.compile(r"\b(ground|space)\b", re.I), "ARENA"),
 (re.compile(r"\d+"), "N"),
]
def abstract(c):
    t = " ".join(filter(None, [c.get("text"), c.get("deployBox"), c.get("epicAction")]))
    for rx, rep in RX: t = rx.sub(rep, t)
    t = re.sub(r"(KEYWORD[ ,.]*){2,}", "KEYWORD ", t)
    t = clean(t)
    return t or (c["type"] + " with no ability text.")
texts = [abstract(c) for c in cards]
json.dump({"renderVersion": 1, "rendering": "abstract", "keys": [c["cardKey"] for c in cards], "texts": texts}, open(S + "/render_abstract.json", "w"), ensure_ascii=False)
print(sha("\n".join(texts).encode()), len(set(texts)), "unique of", len(texts))
for i in (1, 20, 100, 400, 900): print(cards[i]["title"], "=>", texts[i][:220])
