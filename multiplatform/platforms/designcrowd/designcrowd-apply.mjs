// designcrowd-apply.mjs — DRIVER for designcrowd (model: apply). Executes ONE queued action.
// Run in steel-browser (apply model) or via HTTP (post/simple models). Emits RESULT_JSON.
//   env: ACTION_ITEM_JSON (the queue item), plus platform creds from manifest.
// TODO(designcrowd): implement the actual apply action. Until then it reports not-implemented.
const item = process.env.ACTION_ITEM_JSON ? JSON.parse(process.env.ACTION_ITEM_JSON) : {};
console.log("platform=designcrowd action=apply item=" + (item.key || item.url || JSON.stringify(item).slice(0,120)));
console.log("RESULT_JSON " + JSON.stringify({ success:false, notImplemented:true, platform:"designcrowd", reason:"driver not implemented yet" }));
