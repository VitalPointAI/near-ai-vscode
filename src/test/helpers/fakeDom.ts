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
  public removeAttribute(name: string): void { this.attributes.delete(name); }
  public addEventListener(type: string, listener: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  public click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
  /** A key press, as the node's own keydown listeners see it. */
  public press(key: string): void { for (const listener of this.listeners.get('keydown') ?? []) (listener as (event: { key: string; preventDefault(): void }) => void)({ key, preventDefault: () => undefined }); }
  public focus(): void { this.doc.activeElement = this; }
  public append(...nodes: FakeNode[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  public replaceChildren(...nodes: FakeNode[]): void { for (const child of this.children) child.parent = undefined; this.children = []; this.append(...nodes); }
  public prepend(...nodes: FakeNode[]): void { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  public remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; }
  public get attached(): boolean { let node: FakeNode | undefined = this; while (node?.parent) node = node.parent; return node === this.doc.body; }
  public contains(node: FakeNode | undefined): boolean { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  public find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { for (const child of this.children) { if (predicate(child)) return child; const found = child.find(predicate); if (found) return found; } return undefined; }
  public all(predicate: (node: FakeNode) => boolean): FakeNode[] { return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
}
/** An event as a listener sees it: its key (for keydown), its target, and whether a listener already used it. */
export interface FakeEvent { key?: string; target: FakeNode; defaultPrevented: boolean; preventDefault(): void }
export class FakeDocument {
  public readonly body: FakeNode = new FakeNode('body', this);
  public activeElement?: FakeNode;
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  public addEventListener(type: string, listener: (event: FakeEvent) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  /** An event as the browser delivers it: on the target, then on each of its ancestors, then on the document (it bubbles). */
  public dispatch(type: string, target: FakeNode, key?: string): FakeEvent {
    const event: FakeEvent = { ...(key === undefined ? {} : { key }), target, defaultPrevented: false, preventDefault: () => { event.defaultPrevented = true; } };
    for (let at: FakeNode | undefined = target; at; at = at.parent) for (const listener of at.listeners.get(type) ?? []) (listener as (event: FakeEvent) => void)(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  public hasFocus: () => boolean = () => true;
  public createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  public getElementById(id: string): FakeNode | undefined { return this.body.find((node) => node.id === id); }
}
