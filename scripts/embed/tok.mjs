import fs from "fs";
import {encode} from "/Volumes/Local Files/Projects/mault-train/swu-card-data/tokfmt/deps/node_modules/gpt-tokenizer/esm/encoding/o200k_base.js";
const s=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));const o={};
for(const [k,v] of Object.entries(s)){o[k]={tok:+(v.reduce((a,c)=>a+encode(c).length,0)/v.length).toFixed(1),chars:+(v.reduce((a,c)=>a+c.length,0)/v.length).toFixed(1)}}
console.log(JSON.stringify(o));
