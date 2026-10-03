import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const trustedPaths = ["src/server/", "src/trigger/", "src/app/api/", "scripts/", "prisma/", "supabase/"];
const nextPaths = ["src/app/", "src/server/web/"];
// The local operator sweep holds a bootstrap credential; a worker may only reach cleanup through its restricted role.
const bootstrapOnly = ["src/server/maintenance/cleanup-transient.ts"];
// Provider SDKs are server-only and may be imported only by their adapters and the Trigger entrypoints.
const sdkPattern = /^(?:ai|@ai-sdk\/[^/]+|@trigger\.dev\/sdk)(?:\/|$)/;
const sdkOwners = ["src/features/proposals/server/adapters/model.ts", "src/features/proposals/server/adapters/trigger.ts", "src/trigger/"];
// Worker services run inside Trigger, so they are checked as workers whether or not an entrypoint reaches them yet.
const workerRoots = ["src/trigger/", "src/features/proposals/server/run-ai.ts", "src/features/proposals/server/dispatch-ai.ts", "src/features/proposals/server/repair-runs.ts", "src/features/proposals/server/providers.ts", "src/features/proposals/server/adapters/"];

function filesAt(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesAt(path) : sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [path] : [];
  });
}

function compilerOptions(root) {
  const configPath = join(root, "tsconfig.json");
  if (!existsSync(configPath)) return {};
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}

function importsAt(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = [];
  let computedDynamicImport = false;
  source.forEachChild(function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      else computedDynamicImport = true;
    }
    node.forEachChild(visit);
  });
  return { imports, computedDynamicImport, client: /^\s*["']use client["'];?/m.test(source.text) };
}

const inside = (path, prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix);
const featureServer = path => /^src\/features\/[^/]+\/server(?:\/|$)/.test(path);

export function checkBoundaries(root = process.cwd()) {
  const absoluteRoot = resolve(root), options = compilerOptions(absoluteRoot), seen = new Set(), findings = [];
  const resolveImport = (specifier, file) => ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName;
  const visit = (file, mode) => {
    const absoluteFile = resolve(file), key = `${mode}:${absoluteFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { imports, computedDynamicImport } = importsAt(absoluteFile);
    if (computedDynamicImport) findings.push(`${relative(absoluteRoot, absoluteFile)} uses a computed dynamic import.`);
    for (const specifier of imports) {
      if (mode === "client" && (specifier === "@dagrejs/dagre" || specifier.startsWith("@dagrejs/dagre/") || sdkPattern.test(specifier))) { // Dagre is server-only: arranging runs in the save transaction
        findings.push(`${relative(absoluteRoot, absoluteFile)} client import reaches server-only ${specifier}.`);
        continue;
      }
      if (mode === "worker" && (specifier === "next" || specifier.startsWith("next/"))) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} worker import reaches Next module ${specifier}.`);
        continue;
      }
      if (specifier.startsWith("node:") || sdkPattern.test(specifier)) continue; // built-ins and provider SDKs are packages, not source to follow
      const target = resolveImport(specifier, absoluteFile);
      if (!target) { findings.push(`${relative(absoluteRoot, absoluteFile)} cannot resolve ${specifier}.`); continue; }
      const targetPath = relative(absoluteRoot, target).replaceAll("\\", "/");
      if (mode === "client" && (trustedPaths.some(path => inside(targetPath, path)) || featureServer(targetPath))) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} client import reaches trusted module ${targetPath}.`);
        continue;
      }
      if (mode === "worker" && bootstrapOnly.includes(targetPath)) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} worker import reaches bootstrap-credential module ${targetPath}.`);
        continue;
      }
      if (mode === "worker" && nextPaths.some(path => inside(targetPath, path))) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} worker import reaches Next module ${targetPath}.`);
        continue;
      }
      if (inside(targetPath, "src/")) visit(target, mode);
    }
  };
  for (const file of filesAt(join(absoluteRoot, "src"))) {
    const path = relative(absoluteRoot, file).replaceAll("\\", "/");
    if (importsAt(file).client) visit(file, "client");
    if (workerRoots.some(root => inside(path, root) || path === root)) visit(file, "worker");
    if (!sdkOwners.some(owner => inside(path, owner) || path === owner)) for (const specifier of importsAt(file).imports) if (sdkPattern.test(specifier)) findings.push(`${path} imports provider SDK ${specifier} outside its adapter.`);
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkBoundaries();
  if (findings.length) { console.error(findings.join("\n")); process.exitCode = 1; }
}
