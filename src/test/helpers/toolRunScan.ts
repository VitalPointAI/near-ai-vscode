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
// Reflection is a kind of its own (PR #70 review carry-over): a `Reflect.*` call given a tool, a table of tools, or a value the checker cannot type
// (`Reflect.get(tool, 'run')`, `Reflect.apply(...)`, `Reflect.ownKeys(table)`), and an `Object.values`, `Object.entries`, `Object.getOwnPropertyDescriptor(s)`,
// `Object.assign` or `Object.fromEntries` given a tool or a table of tools, each reach a `run` with no name the checker can follow. So is a cast that turns a
// tool into something that is not a tool (`tool as unknown`, `tool as any`, `tool as Record<string, Function>`), which is the other way to lose the type. Each is
// reported where it is written, whatever is done with the result, so none of them is left to a later read the checker cannot see.
//
// What it still cannot see: a tool that reaches code typed only by a structural type with no `run` and is cast back there, or a value built at run time from
// strings (`globalThis[name]`). Neither can happen without a cast or an `any`, which are reported.
import * as path from 'node:path';
import * as ts from 'typescript';

export type RunSiteKind = 'read' | 'destructure' | 'untyped' | 'dynamic-key' | 'reflect' | 'cast';

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

function isAnyOrUnknown(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** A tool, or a value that holds tools: an array, tuple, map, set or record of them, or an object with a tool as one of its own members, a few levels deep. */
function holdsTool(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (isToolShaped(checker, type)) return true;
  if (depth >= 3) return false;
  const apparent = checker.getApparentType(type);
  if (apparent.isUnionOrIntersection()) return apparent.types.some((member) => holdsTool(checker, member, depth + 1));
  const references = (apparent as ts.TypeReference).target === undefined ? [] : checker.getTypeArguments(apparent as ts.TypeReference);
  if (references.some((argument) => holdsTool(checker, argument, depth + 1))) return true;
  if (checker.getIndexInfosOfType(apparent).some((info) => holdsTool(checker, info.type, depth + 1))) return true;
  if ((apparent.flags & ts.TypeFlags.Object) === 0 || (apparent.getCallSignatures().length > 0)) return false;
  return apparent.getProperties().slice(0, 50).some((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return declaration !== undefined && isToolShaped(checker, checker.getTypeOfSymbolAtLocation(property, declaration));
  });
}

/** The `Object` functions that hand back a value's own members without naming them. */
const OBJECT_REFLECTION = new Set(['values', 'entries', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'assign', 'fromEntries']);

/** `Reflect.x(...)` or `Object.x(...)` on the global object of that name, with the member's name. */
function reflectiveCall(node: ts.CallExpression): { on: 'Reflect' | 'Object'; member: string } | undefined {
  const callee = ts.isNonNullExpression(node.expression) ? node.expression.expression : node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  const on = callee.expression.text;
  return on === 'Reflect' || on === 'Object' ? { on, member: callee.name.text } : undefined;
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
      } else if (ts.isCallExpression(node) && reflectiveCall(node) !== undefined) {
        const call = reflectiveCall(node)!;
        const argumentTypes = node.arguments.map((argument) => checker.getTypeAtLocation(argument));
        const reaches = call.on === 'Reflect'
          ? argumentTypes.some((type) => isAnyOrUnknown(type) || holdsTool(checker, type))
          : OBJECT_REFLECTION.has(call.member) && argumentTypes.some((type) => holdsTool(checker, type));
        if (reaches) add(node, 'reflect');
      } else if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && holdsTool(checker, checker.getTypeAtLocation(node.expression))) {
        // A cast that turns a tool, or a table of tools, into something that holds none loses the type every other check follows.
        if (!holdsTool(checker, checker.getTypeAtLocation(node))) add(node, 'cast');
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
