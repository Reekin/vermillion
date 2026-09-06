// UI conformance check for the application shell. Catches the deviations a machine can judge;
// everything else (hierarchy, emphasis, empty states) is the visual review's job.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src", import.meta.url));
const scanned = ["ui/app", "features"].map((dir) => join(root, dir));

// Files that define the primitives and may use raw controls.
const primitives = new Set(["ui/app/components/ui.tsx", "ui/app/components/ContextMenu.tsx", "ui/app/components/Modal.tsx"]);

const stripTokens = (line) => line.replace(/var\(--awb-[a-z-]+\)/g, "");

const rules = [
  {
    id: "awb-class",
    message: "session-shell class (awb-*) outside ui/chat-shell; use ui/app components or a vm-* block in app.css",
    test: (line) => /className=/.test(line) && /\bawb-[a-z]/.test(stripTokens(line))
  },
  {
    id: "raw-color",
    message: "hard-coded color; use a theme token (text-strong, bg-surface, var(--awb-*))",
    test: (line) => /(#[0-9a-fA-F]{3,8}\b|rgba?\()/.test(stripTokens(line))
  },
  {
    id: "arbitrary-style",
    message: "arbitrary Tailwind value for color/size/font; use the scale (text-caption, rounded-md, tracking-eyebrow, ...)",
    test: (line) => /\b(text|bg|border|rounded|font|leading|tracking|shadow)-\[/.test(stripTokens(line))
  },
  {
    // Opt out with data-ui-raw="reason" on the element (full-height editors, search boxes inside popovers).
    id: "raw-field",
    message: "raw <input>/<textarea>/<select>; use Field from components/ui.tsx",
    test: (line, next) =>
      /<(input|textarea|select)\b/.test(line) && !/type="checkbox"|type="radio"|data-ui-raw=/.test(line + " " + next),
    skip: (file) => primitives.has(file)
  }
];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".tsx") ? [path] : [];
  });

const findings = [];
for (const path of scanned.flatMap(walk)) {
  const file = relative(root, path).replaceAll("\\", "/");
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.skip?.(file)) continue;
      if (rule.test(line, lines[index + 1] ?? "")) findings.push(`${file}:${index + 1}  [${rule.id}] ${rule.message}`);
    }
  });
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  console.error(`\n${findings.length} UI conformance issue(s).`);
  process.exit(1);
}
console.log("ui: ok");
