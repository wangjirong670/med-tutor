import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const piGuiRoot = path.join(repoRoot, "scripts/pi-migration/s07/restore-r2/src/pi-gui");
const desktopDir = path.join(piGuiRoot, "apps/desktop");
const piGuiNodeModules = path.join(piGuiRoot, "node_modules");
const stagingDir = path.join(repoRoot, ".study/pi-migration/staging/medtutor-desktop");
const outputDir = path.join(repoRoot, "dist-desktop");
const localElectronDir = path.join(repoRoot, ".study/pi-migration/runtime/electron");

const args = new Set(process.argv.slice(2));
const dirOnly = args.has("--dir");
const skipBuild = args.has("--skip-build");

const WORKSPACE_PACKAGES = [
  { linkName: "session-driver", dir: path.join(piGuiRoot, "packages/session-driver") },
  { linkName: "catalogs", dir: path.join(piGuiRoot, "packages/catalogs") },
  { linkName: "extension-ui", dir: path.join(piGuiRoot, "packages/extension-ui"), hasBrowserBuild: true },
  { linkName: "pi-sdk-driver", dir: path.join(piGuiRoot, "packages/pi-sdk-driver") },
  { linkName: "hermes-memory", dir: path.join(piGuiRoot, "packages/hermes-memory"), isHermes: true },
];

const PACKAGE_COPY_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  ".turbo",
  "__tests__",
  "coverage",
  "__mocks__",
]);

const PACKAGE_ROOT_DIR_EXCLUDES = new Set([
  "test",
  "tests",
  "docs",
  "doc",
  "example",
  "examples",
  "benchmark",
  "benchmarks",
  "fixtures",
]);

const EXCLUDED_FILE_SUFFIXES = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".d.ts.map",
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".css.map",
  ".map",
  ".tsbuildinfo",
  ".md",
  ".markdown",
  ".ts",
  ".mts",
  ".cts",
  ".pdb",
  ".ilk",
  ".ipdb",
  ".cc",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".m",
  ".gyp",
  ".gypi",
  ".sh",
];

function hasExcludedSuffix(fileName) {
  const lower = fileName.toLowerCase();
  if (EXCLUDED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  return /\.(test|spec)\.(js|mjs|cjs)$/i.test(lower);
}

function shouldSkipPlatformOrBuildArtifact(srcPath) {
  const normalized = srcPath.replace(/\\/g, "/");
  const prebuildMatch = normalized.match(/\/prebuilds\/([^/]+)(?:\/|$)/);
  if (prebuildMatch) {
    const platformTag = prebuildMatch[1].toLowerCase();
    if (
      platformTag.startsWith("darwin") ||
      platformTag.startsWith("linux") ||
      platformTag.startsWith("android") ||
      platformTag.startsWith("freebsd") ||
      platformTag.startsWith("openbsd") ||
      platformTag.startsWith("sunos") ||
      platformTag.startsWith("win32-arm64") ||
      platformTag.startsWith("win32-ia32")
    ) {
      return true;
    }
  }
  if (/\/native\/(darwin|linux|freebsd|openbsd|sunos|android)(?:\/|$)/i.test(normalized)) {
    return true;
  }
  if (/\/third_party\/conpty\/[^/]+\/(?!win10-x64(?:\/|$))[^/]+(?:\/|$)/i.test(normalized)) {
    return true;
  }
  if (/\/node_modules\/(?:better-sqlite3|node-pty)\/(?:deps|src|scripts|typings|third_party)(?:\/|$)/i.test(normalized)) {
    return true;
  }
  return false;
}

function logStep(title) {
  console.log(`\n==> [${new Date().toLocaleTimeString()}] ${title}`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function hasJsFiles(dir) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) {
      return true;
    }
    if (entry.isDirectory() && hasJsFiles(full)) {
      return true;
    }
  }
  return false;
}

function runLocalTsc(pkgDir) {
  const tscBin = path.join(piGuiNodeModules, "typescript/bin/tsc");
  if (!existsSync(tscBin)) {
    throw new Error(`TypeScript compiler not found at ${tscBin}`);
  }
  execFileSync(process.execPath, [tscBin, "-p", path.join(pkgDir, "tsconfig.json")], {
    cwd: pkgDir,
    stdio: "inherit",
  });
}

function ensureWorkspacePackages() {
  logStep("Checking @pi-gui/* workspace packages and dist outputs");
  const scopeDir = path.join(desktopDir, "node_modules/@pi-gui");
  mkdirSync(scopeDir, { recursive: true });

  for (const pkg of WORKSPACE_PACKAGES) {
    const distDir = path.join(pkg.dir, "dist");
    if (!hasJsFiles(distDir)) {
      console.log(`Building missing dist for ${path.basename(pkg.dir)}...`);
      if (pkg.isHermes) {
        const tsconfigBuild = path.join(pkg.dir, "tsconfig.build.json");
        const tsconfig = existsSync(tsconfigBuild) ? tsconfigBuild : path.join(pkg.dir, "tsconfig.json");
        execFileSync(process.execPath, [path.join(piGuiNodeModules, "typescript/bin/tsc"), "-p", tsconfig], {
          cwd: pkg.dir,
          stdio: "inherit",
        });
      } else {
        runLocalTsc(pkg.dir);
        if (pkg.hasBrowserBuild) {
          const browserScript = path.join(pkg.dir, "scripts/build-browser.mjs");
          if (existsSync(browserScript)) {
            execFileSync(process.execPath, [browserScript], { cwd: pkg.dir, stdio: "inherit" });
          }
        }
      }
    }

    const linkPath = path.join(scopeDir, pkg.linkName);
    if (!existsSync(linkPath)) {
      symlinkSync(pkg.dir, linkPath, process.platform === "win32" ? "junction" : "dir");
      console.log(`Linked @pi-gui/${pkg.linkName} -> ${pkg.dir}`);
    }
  }
}

async function buildDesktopBundle() {
  if (skipBuild) {
    logStep("Skipping electron-vite build (--skip-build)");
    return;
  }
  logStep("Building production renderer, preload, and main bundles via electron-vite");
  const { build } = await import(
    pathToFileURL(path.join(piGuiNodeModules, "electron-vite/dist/index.js")).href
  );
  const prevCwd = process.cwd();
  process.chdir(desktopDir);
  try {
    await build({
      root: desktopDir,
      configFile: path.join(desktopDir, "electron.vite.config.mjs"),
      mode: "production",
    });
  } finally {
    process.chdir(prevCwd);
  }
}

function resolvePackageDir(depName, searchFromDir) {
  if (depName.startsWith("@pi-gui/")) {
    const subName = depName.slice("@pi-gui/".length);
    const match = WORKSPACE_PACKAGES.find((p) => p.linkName === subName);
    if (match && existsSync(match.dir)) {
      return realpathSync(match.dir);
    }
  }

  // Standard Node upward lookup bounded at piGuiRoot so root med-tutor packages never shadow pi-gui.
  const piGuiRootResolved = path.resolve(piGuiRoot);
  let cursor = path.resolve(searchFromDir);
  while (true) {
    const candidate = path.join(cursor, "node_modules", depName);
    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (cursor === piGuiRootResolved) break;
    const parent = path.dirname(cursor);
    if (parent === cursor || !parent.startsWith(piGuiRootResolved)) break;
    cursor = parent;
  }

  const rootCandidate = path.join(piGuiNodeModules, depName);
  if (existsSync(path.join(rootCandidate, "package.json"))) {
    return realpathSync(rootCandidate);
  }
  return null;
}

function copyFilteredDir(srcDir, destDir, { excludeNodeModules = true } = {}) {
  cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (src === srcDir) return true;
      const base = path.basename(src);
      if (excludeNodeModules && base === "node_modules") return false;
      if (PACKAGE_COPY_EXCLUDES.has(base)) return false;
      if (path.dirname(src) === srcDir && PACKAGE_ROOT_DIR_EXCLUDES.has(base)) return false;
      if (shouldSkipPlatformOrBuildArtifact(src)) return false;
      const stat = lstatSync(src);
      if (stat.isFile() && hasExcludedSuffix(base)) return false;
      return true;
    },
  });
}

function copyPackageFiles(srcRealDir, destDir, isWorkspacePkg) {
  mkdirSync(destDir, { recursive: true });
  if (isWorkspacePkg) {
    cpSync(path.join(srcRealDir, "package.json"), path.join(destDir, "package.json"));
    const distSrc = path.join(srcRealDir, "dist");
    if (existsSync(distSrc)) {
      copyFilteredDir(distSrc, path.join(destDir, "dist"));
    }
    return;
  }

  copyFilteredDir(srcRealDir, destDir);
}

function findNearestAncestorPlacement(placedByNodeModulesDir, startNodeModulesDir, rootNodeModulesDir, depName) {
  let cursor = path.resolve(startNodeModulesDir);
  const rootResolved = path.resolve(rootNodeModulesDir);
  while (true) {
    const mapForDir = placedByNodeModulesDir.get(cursor);
    if (mapForDir?.has(depName)) {
      return { nodeModulesDir: cursor, info: mapForDir.get(depName) };
    }
    if (cursor === rootResolved) break;
    // Walk up from .../pkg/node_modules to parent .../node_modules
    const pkgDir = path.dirname(cursor);
    const parentNodeModules = path.dirname(pkgDir);
    // For scoped packages (@scope/name/node_modules), parent is @scope; check its parent
    const candidateNm =
      path.basename(parentNodeModules) === "node_modules"
        ? parentNodeModules
        : path.dirname(parentNodeModules);
    if (!candidateNm.startsWith(rootResolved) || candidateNm === cursor) break;
    cursor = candidateNm;
  }
  return null;
}

function installRuntimeNodeModules(targetNodeModulesRoot) {
  logStep("Resolving & installing production node_modules (pure Node, zero pnpm)");
  const desktopManifest = readJson(path.join(desktopDir, "package.json"));
  const hermesManifest = readJson(path.join(piGuiRoot, "packages/hermes-memory/package.json"));
  const sdkDriverManifest = readJson(path.join(piGuiRoot, "packages/pi-sdk-driver/package.json"));

  const workspaceRealDirs = new Set(WORKSPACE_PACKAGES.map((p) => realpathSync(p.dir)));

  // Map<nodeModulesDir, Map<depName, { realDir, version }>>
  const placedByNodeModulesDir = new Map();
  const visitedEdges = new Set();
  const queue = [];

  function enqueueDeps(manifest, resolveFromDir, destNodeModulesDir) {
    const deps = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const depName of Object.keys(deps)) {
      queue.push({ depName, resolveFromDir, destNodeModulesDir });
    }
  }

  enqueueDeps(desktopManifest, desktopDir, targetNodeModulesRoot);
  enqueueDeps(hermesManifest, path.join(piGuiRoot, "packages/hermes-memory"), targetNodeModulesRoot);
  enqueueDeps(sdkDriverManifest, path.join(piGuiRoot, "packages/pi-sdk-driver"), targetNodeModulesRoot);
  for (const peerName of Object.keys(hermesManifest.peerDependencies ?? {})) {
    queue.push({
      depName: peerName,
      resolveFromDir: piGuiRoot,
      destNodeModulesDir: targetNodeModulesRoot,
    });
  }

  let copiedCount = 0;

  while (queue.length > 0) {
    const { depName, resolveFromDir, destNodeModulesDir } = queue.shift();
    const realDir = resolvePackageDir(depName, resolveFromDir);
    if (!realDir) continue;

    const pkgJson = readJson(path.join(realDir, "package.json"));
    const isWorkspacePkg = workspaceRealDirs.has(realDir);

    const nearest = findNearestAncestorPlacement(
      placedByNodeModulesDir,
      destNodeModulesDir,
      targetNodeModulesRoot,
      depName,
    );

    let placeNmDir;
    if (!nearest) {
      placeNmDir = targetNodeModulesRoot;
    } else if (nearest.info.realDir === realDir || nearest.info.version === pkgJson.version) {
      // Already satisfied along Node resolution ancestor chain; no duplicate copy needed.
      continue;
    } else {
      // Real version conflict against nearest ancestor; nest under parent's node_modules.
      placeNmDir = destNodeModulesDir;
    }

    const chosenDestDir = path.join(placeNmDir, depName);
    const edgeKey = `${realDir}::${chosenDestDir}`;
    if (visitedEdges.has(edgeKey)) continue;
    visitedEdges.add(edgeKey);

    let dirMap = placedByNodeModulesDir.get(placeNmDir);
    if (!dirMap) {
      dirMap = new Map();
      placedByNodeModulesDir.set(placeNmDir, dirMap);
    }
    dirMap.set(depName, { realDir, version: pkgJson.version });

    copyPackageFiles(realDir, chosenDestDir, isWorkspacePkg);
    copiedCount++;

    enqueueDeps(pkgJson, realDir, path.join(chosenDestDir, "node_modules"));
  }

  console.log(`Installed ${copiedCount} real package directories (0 symlinks/junctions).`);
}

function prepareStagingDir() {
  logStep(`Preparing clean staging directory at ${stagingDir}`);
  rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  mkdirSync(stagingDir, { recursive: true });

  const desktopPkg = readJson(path.join(desktopDir, "package.json"));
  const stagedPkg = {
    name: desktopPkg.name,
    productName: desktopPkg.productName ?? "MedTutor",
    version: desktopPkg.version,
    description: desktopPkg.description,
    author: desktopPkg.author,
    license: desktopPkg.license,
    homepage: desktopPkg.homepage,
    main: desktopPkg.main,
    dependencies: Object.fromEntries(
      Object.entries(desktopPkg.dependencies ?? {}).map(([k, v]) => [
        k,
        String(v).startsWith("workspace:") ? "*" : v,
      ]),
    ),
  };
  writeFileSync(path.join(stagingDir, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

  copyFilteredDir(path.join(desktopDir, "out"), path.join(stagingDir, "out"));

  for (const pkgName of ["pi-sdk-driver", "hermes-memory"]) {
    const srcPkg = path.join(piGuiRoot, "packages", pkgName);
    const destPkg = path.join(stagingDir, "packages", pkgName);
    mkdirSync(destPkg, { recursive: true });
    cpSync(path.join(srcPkg, "package.json"), path.join(destPkg, "package.json"));
    copyFilteredDir(path.join(srcPkg, "dist"), path.join(destPkg, "dist"));
  }

  installRuntimeNodeModules(path.join(stagingDir, "node_modules"));
}

function resolveLocalElectronDist(expectedVersion) {
  const exePath = path.join(localElectronDir, "electron.exe");
  const versionPath = path.join(localElectronDir, "version");
  const icuPath = path.join(localElectronDir, "icudtl.dat");
  const resourcesPath = path.join(localElectronDir, "resources");

  if (!existsSync(exePath) || !existsSync(versionPath) || !existsSync(icuPath) || !existsSync(resourcesPath)) {
    return null;
  }
  const actualVersion = readFileSync(versionPath, "utf8").trim();
  if (expectedVersion && actualVersion !== expectedVersion) {
    console.log(
      `Local electron cache version ${actualVersion} != configured ${expectedVersion}; falling back to download.`,
    );
    return null;
  }
  return localElectronDir;
}

async function ensureWinCodeSignCache() {
  const cacheBase =
    process.env.ELECTRON_BUILDER_CACHE?.trim() ||
    path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache");
  if (!cacheBase) return;

  const winCodeSignDir = path.join(cacheBase, "winCodeSign");
  const targetDir = path.join(winCodeSignDir, "winCodeSign-2.6.0");
  const rceditExe = path.join(targetDir, "rcedit-x64.exe");
  if (existsSync(rceditExe)) {
    return;
  }

  logStep("Preparing Windows winCodeSign-2.6.0 cache (excluding macOS symlinks)");
  mkdirSync(winCodeSignDir, { recursive: true });
  const sevenZipBin = path.join(piGuiNodeModules, "7zip-bin/win/x64/7za.exe");
  if (!existsSync(sevenZipBin)) {
    throw new Error(`7za.exe not found at ${sevenZipBin}`);
  }

  // Reuse any cached .7z if present, otherwise download once via Node fetch
  let archivePath = readdirSync(winCodeSignDir)
    .filter((name) => name.endsWith(".7z"))
    .map((name) => path.join(winCodeSignDir, name))
    .find((p) => existsSync(p) && statSync(p).size > 1_000_000);

  if (!archivePath) {
    archivePath = path.join(winCodeSignDir, "winCodeSign-2.6.0.7z");
    const url =
      "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z";
    console.log(`Downloading ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download winCodeSign-2.6.0.7z: HTTP ${response.status}`);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    writeFileSync(archivePath, buf);
  }

  mkdirSync(targetDir, { recursive: true });
  // Exclude darwin/ symlinks that fail on Windows without SeCreateSymbolicLinkPrivilege
  execFileSync(sevenZipBin, ["x", "-bd", "-y", "-xr!darwin*", archivePath, `-o${targetDir}`], {
    stdio: "inherit",
  });
  if (!existsSync(rceditExe)) {
    throw new Error(`winCodeSign extraction completed without ${rceditExe}`);
  }
}

function assertPackagedLayout(appOutDir, asarModule) {
  const resourcesDir = path.join(appOutDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");

  const requiredDiskPaths = [
    path.join(appOutDir, "MedTutor.exe"),
    path.join(resourcesDir, "icon.png"),
    path.join(resourcesDir, "med-tutor/learning-workbench-r4/s07b-extension.mjs"),
    path.join(resourcesDir, "med-tutor/learning-workbench-r4/method-context.json"),
    path.join(resourcesDir, "med-tutor/scripts/windows-ocr.ps1"),
    path.join(resourcesDir, "med-tutor/scripts/material_pdf.py"),
    asarPath,
    unpackedDir,
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.node"),
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll"),
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe"),
    path.join(unpackedDir, "node_modules/better-sqlite3/prebuilds/win32-x64.node"),
    path.join(
      unpackedDir,
      "node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
    ),
    path.join(unpackedDir, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
    path.join(unpackedDir, "node_modules/@esbuild/win32-x64/esbuild.exe"),
  ];

  const missingDisk = requiredDiskPaths.filter((p) => !existsSync(p));
  if (missingDisk.length > 0) {
    throw new Error(`Packaged layout contract check failed. Missing on disk:\n- ${missingDisk.join("\n- ")}`);
  }

  const asarEntries = new Set(
    asarModule.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]+/, "").replace(/\\/g, "/")),
  );
  const requiredAsarEntries = [
    "package.json",
    "out/main/main.js",
    "packages/pi-sdk-driver/dist/runtime-deps.js",
    "packages/pi-sdk-driver/dist/npm-package-fallback.js",
    "packages/hermes-memory/dist/store/memory-store.js",
    "packages/hermes-memory/dist/store/atomic-lock-coordinator.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-tui/package.json",
    "node_modules/typebox/build/index.mjs",
    "node_modules/node-addon-api/package.json",
    "node_modules/strip-ansi/package.json",
    "node_modules/@pi-gui/pi-sdk-driver/dist/index.js",
    "node_modules/@pi-gui/catalogs/dist/index.js",
    "node_modules/@pi-gui/extension-ui/dist/index.js",
    "node_modules/@pi-gui/session-driver/dist/index.js",
    "node_modules/proper-lockfile/node_modules/retry/package.json",
  ];
  const missingAsar = requiredAsarEntries.filter((entry) => !asarEntries.has(entry));
  if (missingAsar.length > 0) {
    throw new Error(`Packaged app.asar contract check failed. Missing:\n- ${missingAsar.join("\n- ")}`);
  }

  const leakedDevFiles = [];
  for (const entry of asarEntries) {
    if (/\.(d\.ts|d\.mts|d\.cts|map|tsbuildinfo)$/i.test(entry)) {
      leakedDevFiles.push(entry);
    }
  }
  if (leakedDevFiles.length > 0) {
    throw new Error(
      `Development artifacts leaked into app.asar (${leakedDevFiles.length}):\n- ${leakedDevFiles.slice(0, 10).join("\n- ")}`,
    );
  }

  const r4Dir = path.join(resourcesDir, "med-tutor/learning-workbench-r4");
  for (const name of readdirSync(r4Dir)) {
    if (/\.(test|spec)\./i.test(name)) {
      throw new Error(`Test file leaked into packaged resources: ${name}`);
    }
  }

  const stats = computeDirStats(appOutDir);
  if (stats.fileCount >= 3000) {
    throw new Error(`win-unpacked file count ${stats.fileCount} exceeds < 3000 budget`);
  }

  console.log(
    `Verified packaged layout contract in ${appOutDir} (${stats.fileCount} disk files, ${asarEntries.size} asar entries, ${formatBytes(stats.totalBytes)})`,
  );
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function computeDirStats(dirPath) {
  let totalBytes = 0;
  let fileCount = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = computeDirStats(full);
      totalBytes += sub.totalBytes;
      fileCount += sub.fileCount;
    } else if (entry.isFile()) {
      totalBytes += statSync(full).size;
      fileCount += 1;
    }
  }
  return { totalBytes, fileCount };
}

async function runPackager() {
  await ensureWinCodeSignCache();
  logStep(`Running electron-builder (${dirOnly ? "win-unpacked dir only" : "NSIS installer + win-unpacked"})`);

  const requireFromPiGui = createRequire(path.join(piGuiRoot, "package.json"));
  const yaml = requireFromPiGui("yaml");
  const electronBuilder = requireFromPiGui("electron-builder");
  const asarModule = requireFromPiGui("@electron/asar");

  const rawBuilderYml = readFileSync(path.join(desktopDir, "electron-builder.yml"), "utf8");
  const baseConfig = yaml.parse(rawBuilderYml);

  const localElectron = resolveLocalElectronDist(baseConfig.electronVersion);
  if (localElectron) {
    console.log(`Reusing local Electron ${baseConfig.electronVersion} runtime: ${localElectron}`);
  }

  process.env.CSC_IDENTITY_AUTO_DISCOVERY ??= "false";

  const resolvedExtraResources = (baseConfig.extraResources ?? []).map((entry) => ({
    ...entry,
    from: path.resolve(desktopDir, entry.from),
  }));

  const resolvedWin = {
    ...(baseConfig.win ?? {}),
    icon: path.resolve(desktopDir, baseConfig.win?.icon ?? "resources/icon.ico"),
  };

  const resolvedNsis = {
    ...(baseConfig.nsis ?? {}),
    installerIcon: path.resolve(desktopDir, baseConfig.nsis?.installerIcon ?? "resources/icon.ico"),
    uninstallerIcon: path.resolve(desktopDir, baseConfig.nsis?.uninstallerIcon ?? "resources/icon.ico"),
    installerHeaderIcon: path.resolve(
      desktopDir,
      baseConfig.nsis?.installerHeaderIcon ?? "resources/icon.ico",
    ),
  };

  const mergedConfig = {
    ...baseConfig,
    npmRebuild: true, // Required so electron-builder invokes beforeBuild() and sets _nodeModulesHandledExternally=true
    directories: {
      output: outputDir,
      buildResources: path.join(desktopDir, "resources"),
    },
    files: [
      "out/**/*",
      "package.json",
      "packages/pi-sdk-driver/package.json",
      "packages/pi-sdk-driver/dist/**/*",
      "packages/hermes-memory/package.json",
      "packages/hermes-memory/dist/**/*",
      {
        from: "node_modules",
        to: "node_modules",
        filter: ["**/*"],
      },
    ],
    extraResources: resolvedExtraResources,
    win: resolvedWin,
    nsis: resolvedNsis,
    ...(localElectron ? { electronDist: localElectron } : {}),
    beforeBuild: async () => false,
    afterPack: async (context) => {
      assertPackagedLayout(context.appOutDir, asarModule);
    },
  };

  mkdirSync(outputDir, { recursive: true });

  const targets = electronBuilder.Platform.WINDOWS.createTarget(
    dirOnly ? ["dir"] : ["nsis"],
    electronBuilder.Arch.x64,
  );

  const startTime = Date.now();
  const artifactPaths = await electronBuilder.build({
    targets,
    projectDir: stagingDir,
    publish: "never",
    config: mergedConfig,
  });

  logStep(`Packaging completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  const winUnpackedDir = path.join(outputDir, "win-unpacked");
  const exePath = path.join(winUnpackedDir, "MedTutor.exe");
  if (existsSync(exePath)) {
    const stats = computeDirStats(winUnpackedDir);
    console.log(`Portable app exe: ${exePath} (${formatBytes(statSync(exePath).size)})`);
    console.log(
      `win-unpacked total: ${winUnpackedDir} (${stats.fileCount} files, ${formatBytes(stats.totalBytes)})`,
    );
  }

  for (const artifact of artifactPaths) {
    if (existsSync(artifact)) {
      console.log(`Installer artifact: ${artifact} (${formatBytes(statSync(artifact).size)})`);
    }
  }
}

ensureWorkspacePackages();
await buildDesktopBundle();
prepareStagingDir();
await runPackager();
