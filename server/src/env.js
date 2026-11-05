import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Fill missing env vars from the nearest .env, walking up from cwd and from this file. */
export function loadDotEnv() {
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    for (let d = start; ; d = path.dirname(d)) {
      let text;
      try {
        text = fs.readFileSync(path.join(d, ".env"), "utf8");
      } catch {}
      if (text) {
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
          if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
        return;
      }
      if (path.dirname(d) === d) break;
    }
  }
}
