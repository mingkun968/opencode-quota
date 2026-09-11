import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = "opencode-quota@local";
const sourceDir = fileURLToPath(new URL(`../gnome-extension/${UUID}/`, import.meta.url));
const targetDir = join(
  process.env.GNOME_EXTENSION_DIR ?? join(homedir(), ".local/share/gnome-shell/extensions"),
  UUID,
);

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, { recursive: true });

console.log(`Installed ${UUID} -> ${targetDir}`);
console.log(
  "GNOME Shell caches extension modules. Log out and back in (Wayland) or restart the " +
    "shell (X11) so code changes take effect.",
);
