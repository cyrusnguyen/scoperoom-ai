import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const trustedPaths = ["src/server/", "src/trigger/", "src/app/api/", "scripts/", "prisma/", "supabase/"];
const nextPaths = ["src/app/", "src/server/web/"];

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
      if (mode === "worker" && (specifier === "next" || specifier.startsWith("next/"))) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} worker import reaches Next module ${specifier}.`);
        continue;
      }
      const target = resolveImport(specifier, absoluteFile);
      if (!target) { findings.push(`${relative(absoluteRoot, absoluteFile)} cannot resolve ${specifier}.`); continue; }
      const targetPath = relative(absoluteRoot, target).replaceAll("\\", "/");
      if (mode === "client" && (trustedPaths.some(path => inside(targetPath, path)) || featureServer(targetPath))) {
        findings.push(`${relative(absoluteRoot, absoluteFile)} client import reaches trusted module ${targetPath}.`);
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
    if (inside(path, "src/trigger/")) visit(file, "worker");
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = checkBoundaries();
  if (findings.length) { console.error(findings.join("\n")); process.exitCode = 1; }
}
