import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = (...parts) => path.resolve(root, "dist", ...parts);

const REQUIRED = [
  "index.js",
  "late/Late.node.js",
  "freeai/FreeAi.node.js",
  "credentials/LateNode.credentials.js",
  "credentials/FreeAi.credentials.js",
];

test("dist output contains all files declared in package.json#n8n", () => {
  for (const file of REQUIRED) {
    assert.ok(
      existsSync(dist(file)),
      `missing dist/${file} — run \`npm run build\` first`
    );
  }
});

test("package.json n8n entries point at existing dist files", async () => {
  const pkg = JSON.parse(
    await import("node:fs").then((fs) =>
      fs.readFileSync(path.resolve(root, "package.json"), "utf8")
    )
  );
  const entries = [...(pkg.n8n?.nodes ?? []), ...(pkg.n8n?.credentials ?? [])];
  assert.ok(entries.length > 0, "package.json#n8n has no entries");
  for (const entry of entries) {
    assert.ok(
      existsSync(path.resolve(root, entry)),
      `n8n entry points at missing file: ${entry}`
    );
  }
});
