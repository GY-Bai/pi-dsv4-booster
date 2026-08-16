
import { createJiti } from "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "typebox": "/Users/bgy/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
  },
});
const mod = await jiti.import("/Users/bgy/Downloads/pi-dsv4-booster/src/index.ts");
const factory = mod.default ?? mod;
let sreDef = null;
const api = {
  on: () => {},
  registerTool: (def) => { if (def.name === "str_replace_editor") sreDef = def; },
  registerCommand: () => {},
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools: () => {},
  appendEntry: () => {},
};
factory(api);
const workDir = "/tmp/sre-work";
const ctx = { cwd: workDir };
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(workDir + "/demo.txt", "line1\nline2\nline3\nline4\n");
const fs2 = await import("node:fs/promises");
let fails = 0;
const check = (n, c, x="") => { console.log((c?"PASS":"FAIL")+"  "+n+(c?"":"  "+JSON.stringify(x))); if(!c) fails++; };
let r = await sreDef.execute("id1", { command: "view", path: workDir + "/demo.txt" }, undefined, undefined, ctx);
check("view cat -n", r.content[0].text.includes("     2\tline2"), r.content[0].text);
r = await sreDef.execute("id2", { command: "view", path: workDir + "/demo.txt", view_range: [2, 3] }, undefined, undefined, ctx);
check("view range", r.content[0].text.includes("line2") && !r.content[0].text.includes("line4"), r.content[0].text);
r = await sreDef.execute("id3", { command: "str_replace", path: workDir + "/demo.txt", old_str: "line2", new_str: "LINE-TWO" }, undefined, undefined, ctx);
check("replace ok", r.content[0].text.includes("edited successfully"), r.content[0].text);
try { await sreDef.execute("id4", { command: "str_replace", path: workDir + "/demo.txt", old_str: "nope", new_str: "x" }, undefined, undefined, ctx); check("not-found throws", false); }
catch (e) { check("not-found throws", e.message.includes("did not appear verbatim"), e.message); }
writeFileSync(workDir + "/demo.txt", "DUPE\nmid\nDUPE\nend\n");
try { await sreDef.execute("id5", { command: "str_replace", path: workDir + "/demo.txt", old_str: "DUPE", new_str: "X" }, undefined, undefined, ctx); check("ambiguous throws", false); }
catch (e) { check("ambiguous throws", e.message.includes("Multiple occurrences") && e.message.includes("[1, 3]"), e.message); }
writeFileSync(workDir + "/demo.txt", "a\nb\nc\n");
await sreDef.execute("id6", { command: "insert", path: workDir + "/demo.txt", insert_line: 2, new_str: "INSERTED" }, undefined, undefined, ctx);
check("insert after line 2", (await fs2.readFile(workDir + "/demo.txt", "utf8")) === "a\nb\nINSERTED\nc\n", JSON.stringify(await fs2.readFile(workDir + "/demo.txt", "utf8")));
await sreDef.execute("id7", { command: "create", path: workDir + "/new.txt", file_text: "hello" }, undefined, undefined, ctx);
check("create", (await fs2.readFile(workDir + "/new.txt", "utf8")) === "hello");
try { await sreDef.execute("id8", { command: "create", path: workDir + "/new.txt", file_text: "x" }, undefined, undefined, ctx); check("create-existing throws", false); }
catch (e) { check("create-existing throws", e.message.includes("already exists"), e.message); }
try { await sreDef.execute("id9", { command: "rm", path: workDir + "/demo.txt" }, undefined, undefined, ctx); check("bad cmd throws", false); }
catch (e) { check("bad cmd throws", e.message.includes("Invalid command"), e.message); }
console.log(fails === 0 ? "ALL SRE TESTS PASSED" : fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
