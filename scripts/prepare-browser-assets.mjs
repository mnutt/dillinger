import {
  cp,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const MONACO_BUILD = "0.55.1-sandstorm.3";
const isSandstorm = process.env.NEXT_PUBLIC_SANDSTORM === "1";
const source = fileURLToPath(
  new URL("../node_modules/monaco-editor/min/vs", import.meta.url),
);
const destinationRoot = fileURLToPath(
  new URL("../public/vendor/monaco", import.meta.url),
);
const destination = fileURLToPath(
  new URL(`../public/vendor/monaco/${MONACO_BUILD}/vs`, import.meta.url),
);

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

async function copyRelative(relativePath) {
  const target = `${destination}/${relativePath}`;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(`${source}/${relativePath}`, target);
}

function findUnique(entries, expression, label) {
  const matches = entries.filter((name) => expression.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${matches.length}`);
  }
  return matches[0];
}

const topLevelFiles = await readdir(source);
const editorApiFile = findUnique(
  topLevelFiles,
  /^editor\.api-.*\.js$/,
  "Monaco editor API bundle",
);

if (isSandstorm) {
  const markdownFile = findUnique(
    topLevelFiles,
    /^markdown-.*\.js$/,
    "Monaco Markdown tokenizer",
  );
  const workersFile = findUnique(
    topLevelFiles,
    /^workers-.*\.js$/,
    "Monaco worker registration bundle",
  );
  const contributionFiles = topLevelFiles.filter((name) =>
    /^monaco\.contribution-.*\.js$/.test(name)
  );
  if (contributionFiles.length !== 4) {
    throw new Error(
      `Expected four Monaco language contribution bundles, found ${contributionFiles.length}`,
    );
  }

  // editor.main.js has hard AMD dependencies on these contribution modules.
  // Their worker URLs are inert in Sandstorm because editor.api is patched to
  // use Monaco's synchronous local worker before constructing a Web Worker.
  const allowlist = [
    "loader.js",
    "nls.messages-loader.js",
    "nls.messages.js.js",
    "editor/editor.main.css",
    "editor/editor.main.js",
    "basic-languages/monaco.contribution.js",
    editorApiFile,
    markdownFile,
    workersFile,
    ...contributionFiles,
  ];
  await Promise.all(allowlist.map(copyRelative));
} else {
  await cp(source, destination, { recursive: true });
}

// Sandstorm forbids all web workers with worker-src 'none'. Monaco already has
// a synchronous editor-worker fallback, but normally reaches it only after a
// Worker fails (which produces a CSP violation and an error event). Select that
// fallback before Monaco attempts to construct a Worker. The versioned public
// path prevents browsers from reusing an older bundle, and the exact assertion
// makes Monaco upgrades fail loudly if the minified implementation changes.
const editorApiPath = `${destination}/${editorApiFile}`;
const editorApi = await readFile(editorApiPath, "utf8");
const workerFactory =
  '_getOrCreateWorker(){if(!this._worker)try{this._worker=this._register(BAe(this._workerDescriptorOrWorker)),i8.setChannel(this._worker,this._createEditorWorkerHost())}catch(e){YW(e),this._worker=this._createFallbackLocalWorker()}return this._worker}';
const sandstormWorkerFactory =
  '_getOrCreateWorker(){return this._worker||(this._worker=this._createFallbackLocalWorker()),this._worker}';

if (editorApi.split(workerFactory).length !== 2) {
  throw new Error("Could not locate Monaco's editor worker factory to patch");
}

if (isSandstorm) {
  await writeFile(
    editorApiPath,
    editorApi.replace(workerFactory, sandstormWorkerFactory),
  );
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

if (isSandstorm) {
  const compressibleExtensions = new Set([".css", ".js", ".json", ".svg"]);
  for (const path of await walkFiles(destination)) {
    if (!compressibleExtensions.has(extname(path))) continue;
    const contents = await readFile(path);
    if (contents.length < 1024) continue;
    await writeFile(`${path}.gz`, await gzip(contents, { level: 9, mtime: 0 }));
  }
}

const outputFiles = await walkFiles(destination);
let uncompressedBytes = 0;
let compressedBytes = 0;
for (const path of outputFiles) {
  const size = (await stat(path)).size;
  if (path.endsWith(".gz")) compressedBytes += size;
  else uncompressedBytes += size;
}

console.log(
  `Prepared ${isSandstorm ? "minimal Sandstorm" : "complete"} Monaco assets ` +
  `in public/vendor/monaco/${MONACO_BUILD}/vs ` +
  `(${(uncompressedBytes / 1024 / 1024).toFixed(2)} MiB` +
  `${isSandstorm ? `, ${(compressedBytes / 1024 / 1024).toFixed(2)} MiB gzip` : ""})`,
);
