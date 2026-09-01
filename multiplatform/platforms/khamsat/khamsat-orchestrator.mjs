// khamsat-orchestrator.mjs — BRAIN for khamsat (model: apply).
//   node khamsat-orchestrator.mjs scan    -> discover actionable items, write state + queue
//   node khamsat-orchestrator.mjs record <key> <applied|posted|failed> [note]
// State: /app/data/khamsat-state.json  Queue: /app/data/khamsat-queue.json
// TODO(khamsat): implement discovery for the apply model. Until then this is a safe no-op.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const DATA = "/app/data";
const STATE_FILE = DATA + "/khamsat-state.json";
const QUEUE_FILE = DATA + "/khamsat-queue.json";
const NAME = "Nikita N0xeid";
function load(){ try { return { applied:{}, failed:{}, ...JSON.parse(readFileSync(STATE_FILE,"utf8")) }; } catch { return { applied:{}, failed:{} }; } }
function save(s){ mkdirSync(DATA,{recursive:true}); writeFileSync(STATE_FILE, JSON.stringify(s,null,1)); }
async function scan(){
  const state = load();
  const queue = [];
  // TODO(khamsat): populate queue with undiscovered items (skip state.applied / recent state.failed).
  //   e.g. for apply: fetch open gigs; for post: generate service ideas not yet posted.
  writeFileSync(QUEUE_FILE, JSON.stringify({ updatedAt:new Date().toISOString(), queue }, null, 1));
  console.log(JSON.stringify({ platform:"khamsat", model:"apply", discovery:"not-implemented", queued:queue.length, applied:Object.keys(state.applied).length }));
}
function record(key,status,note){
  const s=load(); const e={ at:new Date().toISOString(), note:note||"" };
  if(status==="applied"||status==="posted"){ s.applied[key]=e; delete s.failed[key]; }
  else { s.failed[key]=e; }
  save(s); console.log(JSON.stringify({ok:true,key,status}));
}
const [cmd,...a]=process.argv.slice(2);
(async()=>{ if(cmd==="record") record(a[0],a[1],a[2]??""); else await scan(); })();
