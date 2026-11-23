import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");
const desktop = path.join(source, "apps/desktop");
const tools = path.join(source, "node_modules");

const { build } = await import(
  pathToFileURL(path.join(tools, "electron-vite/dist/index.js")).href
);

process.chdir(desktop);
await build({
  root: desktop,
  configFile: path.join(desktop, "electron.vite.config.mjs"),
  mode: "production",
});
console.log("Desktop build completed successfully.");
