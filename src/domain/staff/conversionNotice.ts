export const WITHHELD_WAY_OUT = 'Ask someone cleared for {label} to make a single-machine copy and share it again.';

/** Name the history and versions the conversion could not share. */
export function conversionNoticeLines(
  withheld: ReadonlyArray<{ product: string; cell: string }>,
  unversioned: ReadonlyArray<{ product: string }>,
  labelOf: (cell: string) => string | undefined
): string[] {
  const notices = withheld.map(({ product, cell }) => {
    const label = labelOf(cell) ?? "the referenced product's label";
    const wayOut = WITHHELD_WAY_OUT.replace('{label}', () => label);
    return { product, text: `Some history for ${product} was left out because it refers to a product with a higher label. ${wayOut}` };
  });
  for (const { product } of unversioned) {
    notices.push({ product, text: `${product} was brought in without its versions because it depends on a product with a higher label.` });
  }
  return notices.sort((a, b) => a.product < b.product ? -1 : a.product > b.product ? 1 : 0).map(({ text }) => text);
}
