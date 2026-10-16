import fs from "fs";
const D="/Volumes/Local Files/Projects/mault-train/swu-card-data";
import {encode as tk} from "/Volumes/Local Files/Projects/mault-train/swu-card-data/tokfmt/deps/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js";
import {encode as te} from "/Volumes/Local Files/Projects/mault-train/swu-card-data/tokfmt/deps/node_modules/@toon-format/toon/dist/index.mjs";
const E=D+"/embed/";const cards=JSON.parse(fs.readFileSync(E+"cards.json","utf8"));
const raw=fs.readFileSync(E+"pkg/llm/cards.toon","utf8");const T=s=>tk(s).length;
const cl=JSON.parse(fs.readFileSync(E+"out-clusterbycard.json","utf8"));const sim=JSON.parse(fs.readFileSync(E+"out-similar.json","utf8"));const vecs=JSON.parse(fs.readFileSync(E+"out-vecs.json","utf8"));
const out={cardsToon:T(raw),bytes:raw.length};
const withCl=cards.map((c,i)=>({...c,cluster:cl[i].cluster,clusterLabel:cl[i].clusterLabel}));
out.cardsWithClusterCols=T(te({cards:withCl}));
out.similarToon=T(te({similar:sim}));
const labelsOnce=JSON.parse(fs.readFileSync(E+"clusters.json","utf8")).labels;
out.clusterLegend=T(te({clusters:Object.entries(labelsOnce).map(([id,label])=>({id:+id,label}))}));
out.cardsWithClusterIdOnly=T(te({cards:cards.map((c,i)=>({...c,cluster:cl[i].cluster}))}));
for(const [k,v] of Object.entries(vecs)){
  out["vectorsToon_"+k]=T(te({vectors:cards.map((c,i)=>({cardKey:c.cardKey,vec:v.cells[i]}))}));
  out["cardsWithVecCol_"+k]=T(te({cards:cards.map((c,i)=>({...c,vec:v.cells[i]}))}));
}
const s=te({vectors:cards.slice(0,2).map((c,i)=>({cardKey:c.cardKey,vec:vecs["128-int8"].cells[i]}))});out.sample=s;
fs.writeFileSync(E+"sample-vectors.toon.txt",te({vectors:cards.slice(0,3).map((c,i)=>({cardKey:c.cardKey,vec:vecs["64-int8"].cells[i]}))})+"\n");
out.simSample=te({similar:sim.slice(1,3)});
console.log(JSON.stringify(out,null,1));
