import json, re, hashlib, sys, os
RENDER_VERSION = 1
S = os.environ.get("EMBED_WORK") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tmp", "embed-work")
def ws(s):
    return re.sub(r"\s+", " ", (s or "").replace("|", ", ")).strip() if s else ""
def clean(s):
    return re.sub(r"\s+", " ", s).strip() if isinstance(s, str) else ""
def lst(s):
    return ", ".join(p for p in (s or "").split("|") if p) if isinstance(s, str) else ""
def full(c):
    parts = []
    t = clean(c["title"]) + (", " + clean(c["subtitle"]) if c.get("subtitle") else "")
    parts.append(t + ".")
    ty = c["type"] + (" (" + c["type2"] + ")" if c.get("type2") and c["type2"] != c["type"] else "")
    parts.append(ty + ".")
    if c.get("arenas"): parts.append("Arena: " + lst(c["arenas"]) + ".")
    if c.get("aspects"): parts.append("Aspects: " + lst(c["aspects"]) + ".")
    if c.get("traits"): parts.append("Traits: " + lst(c["traits"]) + ".")
    if c.get("keywords"): parts.append("Keywords: " + lst(c["keywords"]) + ".")
    if clean(c.get("text")): parts.append("Text: " + clean(c["text"]))
    if clean(c.get("deployBox")): parts.append("Deploy: " + clean(c["deployBox"]))
    if clean(c.get("epicAction")): parts.append("Epic Action: " + clean(c["epicAction"]))
    return " ".join(parts)
def ability(c):
    parts = []
    if c.get("keywords"): parts.append("Keywords: " + lst(c["keywords"]) + ".")
    if clean(c.get("text")): parts.append(clean(c["text"]))
    if clean(c.get("deployBox")): parts.append("Deploy: " + clean(c["deployBox"]))
    if clean(c.get("epicAction")): parts.append("Epic Action: " + clean(c["epicAction"]))
    return " ".join(parts) or (c["type"] + " with no ability text.")
def load():
    return json.load(open(S + "/cards.json"))
def sha(b): return hashlib.sha256(b).hexdigest()
if __name__ == "__main__":
    cards = load()
    for name, fn in (("full", full), ("ability", ability)):
        texts = [fn(c) for c in cards]
        json.dump({"renderVersion": RENDER_VERSION, "rendering": name, "keys": [c["cardKey"] for c in cards], "texts": texts}, open(f"{S}/render_{name}.json", "w"), ensure_ascii=False)
        print(name, sha("\n".join(texts).encode()), sum(map(len, texts)) // len(texts), "avg chars")
    print(full(cards[1])); print(ability(cards[1]))
