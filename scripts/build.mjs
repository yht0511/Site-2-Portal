import { copyFile, mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
const files = ["index.html", "app.js", "styles.css", "services.yaml"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(
  files.map((file) => copyFile(new URL(file, root), new URL(file, output))),
);
console.log(`已将 ${files.length} 个网站文件复制到 dist/`);
