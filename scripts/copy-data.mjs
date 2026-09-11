import { chmod, copyFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

const files = [
  {
    src: join("src", "data", "modelsdev-pricing.min.json"),
    dst: join("dist", "data", "modelsdev-pricing.min.json"),
  },
  {
    src: join("src", "widget", "overlay.py"),
    dst: join("dist", "widget", "overlay.py"),
  },
];

for (const f of files) {
  await mkdir(dirname(f.dst), { recursive: true });
  await copyFile(f.src, f.dst);
}

// tsc emits the CLI without the executable bit, which breaks PATH-based wrappers.
await chmod(join("dist", "bin", "opencode-quota.js"), 0o755);
