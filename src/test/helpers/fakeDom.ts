// A small DOM stand-in shared by the webview card tests (setup nudge, pick-up card): just enough of Document and Element for the helpers in media/chat.
export class FakeNode {
  public children: FakeNode[] = [];
  public parent?: FakeNode;
  public className = '';
  public id = '';
  public type = '';
  public hidden = false;
  public value = '';
  public textContent = '';
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<() => void>>();
  public constructor(public readonly tagName: string, private readonly doc: FakeDocument) {}
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
  public append(...nodes: FakeNode[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  public prepend(...nodes: FakeNode[]): void { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  public remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; }
  public get attached(): boolean { let node: FakeNode | undefined = this; while (node?.parent) node = node.parent; return node === this.doc.body; }
  public contains(node: FakeNode | undefined): boolean { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  public find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { for (const child of this.children) { if (predicate(child)) return child; const found = child.find(predicate); if (found) return found; } return undefined; }
  public all(predicate: (node: FakeNode) => boolean): FakeNode[] { return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
}
export class FakeDocument {
  public readonly body: FakeNode = new FakeNode('body', this);
  public activeElement?: FakeNode;
  public hasFocus: () => boolean = () => true;
  public createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  public getElementById(id: string): FakeNode | undefined { return this.body.find((node) => node.id === id); }
}
