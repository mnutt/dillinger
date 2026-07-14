import {
  access,
  cp,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

const projectRoot = process.cwd();
const nextRoot = join(projectRoot, ".next");
const nextStaticRoot = join(nextRoot, "static");
const packageRoot = join(nextRoot, "sandstorm-package");
const indexSource = join(nextRoot, "server/app/index.html");

function inside(root, path) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function addMatches(set, text, expression, group = 1) {
  for (const match of text.matchAll(expression)) set.add(match[group]);
}

function compileWebpackPathResolver(runtime, property, followingProperty) {
  const expression = new RegExp(
    `\\.${property}=function\\(e\\)\\{([\\s\\S]*?)\\},[A-Za-z_$][\\w$]*\\.${followingProperty}=`,
  );
  const match = runtime.match(expression);
  if (!match) throw new Error(`Could not read webpack ${property} resolver`);

  // This body is generated locally by the just-completed Next build. It is a
  // pure return expression mapping numeric chunk IDs to fingerprinted paths.
  return new Function("e", match[1]);
}

function relativeStaticPath(path) {
  return path.startsWith("static/") ? path.slice("static/".length) : path;
}

async function collectNextAssets(indexHtml) {
  const assets = new Set();
  addMatches(
    assets,
    indexHtml,
    /(?:src|href)="\/_next\/static\/([^"?#]+)(?:[?#][^"]*)?"/g,
  );

  const webpackPath = [...assets].find((path) =>
    /^chunks\/webpack-[a-f0-9]+\.js$/.test(path)
  );
  if (!webpackPath) throw new Error("Static editor HTML has no webpack runtime");
  const webpackRuntime = await readFile(join(nextStaticRoot, webpackPath), "utf8");
  const chunkPath = compileWebpackPathResolver(webpackRuntime, "u", "miniCssF");
  const cssPath = compileWebpackPathResolver(webpackRuntime, "miniCssF", "g");

  // Follow lazy imports from the entry chunks and then from each discovered
  // chunk. This retains Markdown rendering and optional Vim/Emacs support,
  // while excluding chunks belonging only to unrelated statically-built pages.
  const pendingJavaScript = [...assets].filter((path) => path.endsWith(".js"));
  const scannedJavaScript = new Set();
  while (pendingJavaScript.length > 0) {
    const path = pendingJavaScript.pop();
    if (scannedJavaScript.has(path)) continue;
    scannedJavaScript.add(path);

    const source = await readFile(join(nextStaticRoot, path), "utf8");
    const chunkIds = new Set();
    addMatches(chunkIds, source, /\.e\((\d+)\)/g);
    for (const chunkId of chunkIds) {
      const resolvedJavaScript = chunkPath(Number(chunkId));
      const javascript = typeof resolvedJavaScript === "string"
        ? relativeStaticPath(resolvedJavaScript)
        : resolvedJavaScript;
      if (typeof javascript === "string" &&
          await exists(join(nextStaticRoot, javascript)) &&
          !assets.has(javascript)) {
        assets.add(javascript);
        pendingJavaScript.push(javascript);
      }

      const resolvedStylesheet = cssPath(Number(chunkId));
      const stylesheet = typeof resolvedStylesheet === "string"
        ? relativeStaticPath(resolvedStylesheet)
        : resolvedStylesheet;
      if (typeof stylesheet === "string" &&
          await exists(join(nextStaticRoot, stylesheet))) {
        assets.add(stylesheet);
      }
    }
  }

  // CSS emitted by Next refers to fingerprinted fonts and images relatively.
  // Follow those URLs rather than copying the whole media directory.
  for (const stylesheet of [...assets].filter((path) => path.endsWith(".css"))) {
    const source = await readFile(join(nextStaticRoot, stylesheet), "utf8");
    for (const match of source.matchAll(/url\((?:"|')?([^"')?#]+)(?:[?#][^"')]*)?(?:"|')?\)/g)) {
      const referenced = match[1];
      if (/^(?:data:|https?:)/.test(referenced) ||
          (referenced.startsWith("/") && !referenced.startsWith("/_next/static/"))) {
        continue;
      }
      const resolved = referenced.startsWith("/_next/static/")
        ? referenced.slice("/_next/static/".length)
        : posix.normalize(posix.join(posix.dirname(stylesheet), referenced));
      if (!inside(nextStaticRoot, join(nextStaticRoot, resolved))) {
        throw new Error(`CSS asset escapes .next/static: ${referenced}`);
      }
      assets.add(resolved);
    }
  }

  for (const path of assets) {
    const source = join(nextStaticRoot, path);
    if (!inside(nextStaticRoot, source) || !(await exists(source))) {
      throw new Error(`Missing Next browser asset: ${path}`);
    }
  }
  return [...assets].sort();
}

async function copyPackageClosure(entryPackages) {
  const pending = [...entryPackages];
  const copied = new Set();
  while (pending.length > 0) {
    const packageName = pending.pop();
    if (copied.has(packageName)) continue;
    const source = join(projectRoot, "node_modules", packageName);
    const packageJsonPath = join(source, "package.json");
    if (!(await exists(packageJsonPath))) {
      // Missing optional dependencies are expected on unsupported platforms.
      continue;
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    const destination = join(packageRoot, "node_modules", packageName);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      filter: (path) => path === source ||
        !relative(source, path).split(sep).includes("node_modules"),
    });
    copied.add(packageName);
    pending.push(
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.optionalDependencies || {}),
    );
  }
  return [...copied].sort();
}

await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

const indexHtml = await readFile(indexSource, "utf8");
await copyFile(indexSource, join(packageRoot, "index.html"));

await build({
  entryPoints: [join(projectRoot, "sandstorm/server.ts")],
  outfile: join(packageRoot, "server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["@sparticuz/chromium"],
  legalComments: "none",
  minifySyntax: true,
  minifyWhitespace: true,
});

const runtimePackages = await copyPackageClosure(["@sparticuz/chromium"]);
const nextAssets = await collectNextAssets(indexHtml);
for (const path of nextAssets) {
  const destination = join(packageRoot, ".next/static", path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(nextStaticRoot, path), destination);
}

// These are the only non-Next browser assets used by the Sandstorm editor.
// Monaco's directory is already reduced to its AMD editor/Markdown allowlist
// and precompressed by prepare-browser-assets.mjs.
const publicFiles = [
  "apple-touch-icon.png",
  "icon-192x192.png",
  "icon-512x512.png",
  "site.webmanifest",
];
for (const path of publicFiles) {
  const destination = join(packageRoot, "public", path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(projectRoot, "public", path), destination);
}
await cp(join(projectRoot, "public/vendor"), join(packageRoot, "public/vendor"), {
  recursive: true,
});

// Next emits favicon.ico as a route body rather than copying it to public.
await copyFile(
  join(nextRoot, "server/app/favicon.ico.body"),
  join(packageRoot, "public/favicon.ico"),
);

async function directorySize(path) {
  const entries = await import("node:fs/promises").then(({ readdir }) =>
    readdir(path, { withFileTypes: true })
  );
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }
  return bytes;
}

const packageBytes = await directorySize(packageRoot);
console.log(
  `Built Sandstorm runtime: ${nextAssets.length} Next assets, ` +
  `${publicFiles.length + 2} public asset roots, ` +
  `${runtimePackages.length} external runtime packages, ` +
  `${(packageBytes / 1024 / 1024).toFixed(2)} MiB total`,
);
