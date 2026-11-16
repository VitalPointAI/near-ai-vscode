// Finds every place an AgentTool's `run` is reached, with the TypeScript type checker instead of text matching (PR #70 third review). A text scan for
// `tool.run(` misses an alias (`const t = tool; t.run(...)`), an array element (`tools[0].run(...)`), a destructured name (`const { run } = tool`), a bracket
// access (`tool['run']`) and a variable the scan has no word for. The checker knows the type of the thing the member is read from, so it finds all of them.
//
// What counts as a site: any read of the member `run` from a value whose type is an AgentTool (by its shape: a `run`, a `manifest`, a `parse`, a `title` and a
// `capability`, so a type that merely extends or intersects it counts too). A call, a `.call`/`.bind`, and a function passed along as `tool.run` are each one
// site, at the read. A `run` read from a value typed `any` is its own kind, because the checker cannot say what it is; a bracket access with a key that is not a
// literal on an AgentTool is another, because the key could be `run`. A `run` method that is only defined (an object literal's own `run() {}`, or the
// override in `{ ...tool, run }`) is not a site: nothing is reached by defining it.
//
// What it cannot see: a member reached by reflection (`Reflect.get(tool, 'run')`, `Object.values(tool)`) or from a value cast through `unknown` to something that
// is not an AgentTool. Both would have to be written on purpose, and the `any` and dynamic-key kinds are reported so the usual accidents are not silent.
import * as path from 'node:path';
import * as ts from 'typescript';

export type RunSiteKind = 'read' | 'destructure' | 'untyped' | 'dynamic-key';

export interface RunSite {
  /** Repository-relative, forward slashes. */
  readonly file: string;
  readonly line: number;
  readonly kind: RunSiteKind;
  /** The source text of the access, for a failure message. */
  readonly text: string;
}

/** A program over the given files with the repository's own compiler options, never emitting. */
export function programFor(repoRoot: string, rootNames: readonly string[]): ts.Program {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  return ts.createProgram({ rootNames: [...rootNames], options: { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined } });
}

/** The files of the repository's own tsconfig (all of src), as absolute paths. */
export function configuredFiles(repoRoot: string): string[] {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot).fileNames;
}

const TOOL_MEMBERS = ['run', 'manifest', 'parse', 'title', 'capability'] as const;

function isToolShaped(checker: ts.TypeChecker, type: ts.Type): boolean {
  const apparent = checker.getApparentType(type);
  if (apparent.isUnion()) return apparent.types.some((member) => isToolShaped(checker, member));
  return TOOL_MEMBERS.every((name) => checker.getPropertyOfType(apparent, name) !== undefined);
}

function isAny(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

/** Every site in the given files (absolute paths) that the program contains. `repoRoot` makes the file names relative. */
export function findToolRunSites(program: ts.Program, repoRoot: string, files: readonly string[]): RunSite[] {
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((file) => path.resolve(file)));
  const sites: RunSite[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !wanted.has(path.resolve(source.fileName))) continue;
    const relative = path.relative(repoRoot, source.fileName).split(path.sep).join('/');
    const add = (node: ts.Node, kind: RunSiteKind): void => {
      sites.push({ file: relative, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, text: node.getText(source).replace(/\s+/g, ' ').slice(0, 120) });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'run') {
        const type = checker.getTypeAtLocation(node.expression);
        if (isToolShaped(checker, type)) add(node, 'read');
        else if (isAny(type)) add(node, 'untyped');
      } else if (ts.isElementAccessExpression(node)) {
        const type = checker.getTypeAtLocation(node.expression);
        if (isToolShaped(checker, type)) {
          const key = checker.getTypeAtLocation(node.argumentExpression);
          if (key.isStringLiteral()) { if (key.value === 'run') add(node, 'read'); }
          else if (key.isUnion() && key.types.every((member) => member.isStringLiteral())) { if (key.types.some((member) => member.isStringLiteral() && member.value === 'run')) add(node, 'read'); }
          else add(node, 'dynamic-key');
        } else if (isAny(type) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'run') add(node, 'untyped');
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        const reads = (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'run';
        if (reads && !node.dotDotDotToken) {
          const type = checker.getTypeAtLocation(node.parent);
          if (isToolShaped(checker, type)) add(node, 'destructure');
          else if (isAny(type)) add(node, 'untyped');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/** The sites counted per file, for comparing with a list. */
export function countByFile(sites: readonly RunSite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const site of sites) out[site.file] = (out[site.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
