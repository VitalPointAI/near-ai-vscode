import type { Label } from '../../domain/gate/labels';

export interface DataMapItem {
  readonly itemId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly label: Label;
}

export interface DataMapSnapshot {
  readonly items: readonly DataMapItem[];
}
