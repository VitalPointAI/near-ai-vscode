import { DocImage } from './docImages';
import { Block, Inline, ListItem, Note } from './docMarkdown';
import { pdfDate, type DocumentSpec } from './pdfWriter';
import { ToolError } from './workspace';
import { writeZip } from './zip';

// A Word document (.docx, WordprocessingML) from the Markdown subset, written here as XML and
// zipped with the same writer the decks use. Headings use Word's built-in Heading 1-4 styles, so
// the Navigation pane and a table of contents work; tables, lists, links, and pictures are real
// Word objects, and footnotes are real Word footnotes or endnotes that Word numbers and links. The zip carries a fixed timestamp and the parts are always in the same order, so
// the same input gives the same bytes.

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships'
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Page size and margins in twentieths of a point. */
const PAGE = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } };
const MARGIN = 1134;
const EMU_PER_TWIP = 635;
const EMU_PER_PIXEL = 9525;

/** Escapes XML text and drops characters XML 1.0 cannot hold. */
export const xml = (value: string) => value.replace(/[^\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DocxResult { bytes: Buffer; headings: number; tables: number; images: number; notes: number }
type Rel = { id: string; type: string; target: string; external?: boolean };

class DocumentBuilder {
  public readonly rels: Rel[] = [];
  /** The notes part keeps its own relationships (its links). */
  public readonly noteRels: Rel[] = [];
  public readonly media: Array<{ name: string; bytes: Buffer }> = [];
  public readonly numbering: number[] = [];
  public headings = 0;
  public tables = 0;
  private readonly mediaBySource = new Map<string, string>();
  private readonly links = new Map<Rel[], Map<string, string>>();
  private readonly referenced = new Set<number>();
  private readonly noteNumbers: Map<string, number>;
  private drawingId = 0;

  public constructor(private readonly images: Map<string, DocImage>, private readonly textWidth: number, private readonly textHeight: number, notes: Note[], private readonly noteKind: 'footnote' | 'endnote') {
    this.noteNumbers = new Map(notes.map((note) => [note.id, note.number]));
  }

  private rel(type: string, target: string, external = false, into: Rel[] = this.rels): string {
    const id = `rId${into.length + 10}`;
    into.push({ id, type, target, ...(external ? { external } : {}) });
    return id;
  }

  private get noteStyle(): string { return this.noteKind === 'footnote' ? 'FootnoteReference' : 'EndnoteReference'; }

  public runs(inlines: Inline[], base: { bold?: boolean; italic?: boolean } = {}, rels: Rel[] = this.rels): string {
    return inlines.map((run) => {
      if (run.note !== undefined) {
        const number = this.noteNumbers.get(run.note);
        if (number === undefined) throw new ToolError(`Footnote reference [^${run.note}] has no definition.`);
        // Word gives each note one reference; a later citation of the same note repeats its number.
        if (this.referenced.has(number)) return `<w:r><w:rPr><w:rStyle w:val="${this.noteStyle}"/></w:rPr><w:t>${number}</w:t></w:r>`;
        this.referenced.add(number);
        return `<w:r><w:rPr><w:rStyle w:val="${this.noteStyle}"/></w:rPr><w:${this.noteKind}Reference w:id="${number}"/></w:r>`;
      }
      const properties = [
        run.link ? '<w:rStyle w:val="Hyperlink"/>' : run.code ? '<w:rStyle w:val="InlineCode"/>' : '',
        base.bold || run.bold ? '<w:b/>' : '',
        base.italic || run.italic ? '<w:i/>' : ''
      ].join('');
      const body = run.text.split('\n').map((part) => `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('<w:br/>');
      const element = `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${body}</w:r>`;
      if (!run.link) return element;
      if (run.link.startsWith('#')) return `<w:hyperlink w:anchor="${xml(run.link.slice(1))}">${element}</w:hyperlink>`;
      const known = this.links.get(rels) ?? new Map<string, string>();
      this.links.set(rels, known);
      let id = known.get(run.link);
      if (!id) { id = this.rel(`${REL}/hyperlink`, run.link, true, rels); known.set(run.link, id); }
      return `<w:hyperlink r:id="${id}">${element}</w:hyperlink>`;
    }).join('');
  }

  private paragraph(style: string | undefined, content: string, extra = ''): string {
    return `<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''}${content}</w:p>`;
  }

  public block(block: Block): string {
    switch (block.kind) {
      case 'heading': this.headings += 1; return this.paragraph(`Heading${block.level}`, this.runs(block.inlines));
      case 'paragraph': return this.paragraph(undefined, this.runs(block.inlines));
      case 'quote': return block.paragraphs.map((paragraph) => this.paragraph('Quote', this.runs(paragraph))).join('');
      case 'code': return this.paragraph('CodeBlock', block.text.split('\n').map((line) => `<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('<w:r><w:br/></w:r>'));
      case 'rule': return this.paragraph(undefined, '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFC5CC"/></w:pBdr>');
      case 'list': return this.list(block.items);
      case 'table': return this.table(block);
      case 'image': return this.image(block.src, block.alt);
    }
  }

  /** Bullets share one numbering; each numbered list gets its own, so it starts at its first number. */
  private list(items: ListItem[]): string {
    let ordered: number | undefined;
    return items.map((item) => {
      let id = 1;
      if (item.ordered) {
        if (ordered === undefined) { this.numbering.push(item.number); ordered = this.numbering.length + 1; }
        id = ordered;
      }
      return this.paragraph('ListParagraph', this.runs(item.inlines), `<w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${id}"/></w:numPr>`);
    }).join('');
  }

  private table(block: Extract<Block, { kind: 'table' }>): string {
    this.tables += 1;
    const columns = block.header.length;
    const length = (cell: Inline[]) => Math.min(60, Math.max(4, cell.reduce((sum, run) => sum + run.text.length, 0)));
    const weight = Array.from({ length: columns }, (_, column) => Math.max(...[block.header, ...block.rows].map((row) => length(row[column]))));
    const total = weight.reduce((a, b) => a + b, 0);
    const widths = weight.map((value) => Math.floor(this.textWidth * value / total));
    const cell = (inlines: Inline[], column: number, header: boolean) => {
      const align = block.align[column] === 'left' ? '' : `<w:jc w:val="${block.align[column] === 'center' ? 'center' : 'right'}"/>`;
      return `<w:tc><w:tcPr><w:tcW w:w="${widths[column]}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEFF3"/>' : ''}</w:tcPr><w:p><w:pPr><w:pStyle w:val="TableText"/>${align}</w:pPr>${this.runs(inlines, { bold: header })}</w:p></w:tc>`;
    };
    const header = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${block.header.map((inlines, column) => cell(inlines, column, true)).join('')}</w:tr>`;
    const rows = block.rows.map((row) => `<w:tr>${row.map((inlines, column) => cell(inlines, column, false)).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${header}${rows}</w:tbl>${this.paragraph(undefined, '', '<w:spacing w:after="0"/>')}`;
  }

  private image(src: string, alt: string): string {
    const image = this.images.get(src);
    if (!image) throw new ToolError(`Image ${src} was not loaded.`);
    let name = this.mediaBySource.get(src);
    if (!name) {
      name = `image${this.media.length + 1}.${image.format === 'jpeg' ? 'jpeg' : 'png'}`;
      this.media.push({ name, bytes: image.bytes });
      this.mediaBySource.set(src, name);
    }
    const id = this.rel(`${REL}/image`, `media/${name}`);
    // 96 pixels to the inch, scaled down to fit the text area (and three quarters of its height).
    const scale = Math.min(1, (this.textWidth * EMU_PER_TWIP) / (image.width * EMU_PER_PIXEL), (this.textHeight * 0.75 * EMU_PER_TWIP) / (image.height * EMU_PER_PIXEL));
    const cx = Math.round(image.width * EMU_PER_PIXEL * scale);
    const cy = Math.round(image.height * EMU_PER_PIXEL * scale);
    this.drawingId += 1;
    const description = xml(alt || image.name);
    const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${this.drawingId}" name="Picture ${this.drawingId}" descr="${description}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${this.drawingId}" name="${xml(name)}" descr="${description}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    return this.paragraph('Figure', drawing) + (alt ? this.paragraph('Caption', this.runs([{ text: alt }])) : '');
  }
}

/** footnotes.xml or endnotes.xml: Word's two separator notes, then one note per definition. */
function notesPart(builder: DocumentBuilder, notes: Note[], kind: 'footnote' | 'endnote'): string {
  const style = kind === 'footnote' ? 'Footnote' : 'Endnote';
  const separators = `<w:${kind} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`;
  const body = notes.map((note) => `<w:${kind} w:id="${note.number}"><w:p><w:pPr><w:pStyle w:val="${style}Text"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${style}Reference"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>${builder.runs(note.inlines, {}, builder.noteRels)}</w:p></w:${kind}>`).join('');
  return `${XML_HEAD}<w:${kind}s xmlns:w="${NS.w}" xmlns:r="${NS.r}">${separators}${body}</w:${kind}s>`;
}

function styles(): string {
  const paragraph = (id: string, name: string, body: string, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"${extra}><w:name w:val="${name}"/>${body}</w:style>`;
  const heading = (level: number, size: number, before: number) => paragraph(`Heading${level}`, `heading ${level}`, `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${level === 1 ? '0F172A' : '1F2937'}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`);
  return `${XML_HEAD}<w:styles xmlns:w="${NS.w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + paragraph('Normal', 'Normal', '<w:qFormat/>', ' w:default="1"')
    + paragraph('Title', 'Title', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr>')
    + heading(1, 36, 360) + heading(2, 30, 280) + heading(3, 26, 240) + heading(4, 23, 200)
    + paragraph('Quote', 'Quote', '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CBD2D9"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr>')
    + paragraph('CodeBlock', 'Code Block', '<w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/><w:spacing w:after="140" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="18"/></w:rPr>')
    + paragraph('ListParagraph', 'List Paragraph', '<w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr>')
    + paragraph('TableText', 'Table Text', '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="19"/></w:rPr>')
    + paragraph('Figure', 'Figure', '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr>')
    + paragraph('Caption', 'caption', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:qFormat/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr>')
    + paragraph('FootnoteText', 'footnote text', '<w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>')
    + paragraph('EndnoteText', 'endnote text', '<w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>')
    + paragraph('Footer', 'footer', '<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="17"/></w:rPr>')
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:color w:val="1D4ED8"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/></w:tblBorders></w:tblPr></w:style>'
    + '</w:styles>';
}

function numbering(ordered: number[]): string {
  const bullets = ['•', '–', '◦'];
  const levels = (format: 'bullet' | 'decimal') => Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format === 'bullet' ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][level % 3]}"/><w:lvlText w:val="${format === 'bullet' ? bullets[level % 3] : `%${level + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  return `${XML_HEAD}<w:numbering xmlns:w="${NS.w}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + ordered.map((start, index) => `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
}

const relationships = (entries: Rel[]) => `${XML_HEAD}<Relationships xmlns="${NS.rel}">${entries.map((entry) => `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${xml(entry.target)}"${entry.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;

/** W3CDTF from an ISO date, for the core properties. */
const coreDate = (value: string) => { const d = pdfDate(value); return `${d.slice(2, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}T${d.slice(10, 12)}:${d.slice(12, 14)}:${d.slice(14, 16)}Z`; };

export function createDocx(spec: DocumentSpec): DocxResult {
  const page = PAGE[spec.pageSize ?? 'A4'];
  const notes = spec.notes ?? [];
  const kind: 'footnote' | 'endnote' = (spec.noteStyle ?? 'endnotes') === 'footnotes' ? 'footnote' : 'endnote';
  const builder = new DocumentBuilder(spec.images, page.width - 2 * MARGIN, page.height - 2 * MARGIN, notes, kind);
  const body = spec.blocks.map((block) => builder.block(block)).join('');
  const notesXml = notes.length ? notesPart(builder, notes, kind) : undefined;
  const footer = `${XML_HEAD}<w:ftr xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const section = `<w:sectPr><w:footerReference w:type="default" r:id="rId4"/>${kind === 'endnote' && notes.length ? '<w:endnotePr><w:numFmt w:val="decimal"/></w:endnotePr>' : ''}<w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const document = `${XML_HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>${body}${section}</w:body></w:document>`;
  const date = spec.date ? coreDate(spec.date) : undefined;
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(spec.title)}</dc:title>${spec.author ? `<dc:creator>${xml(spec.author)}</dc:creator><cp:lastModifiedBy>${xml(spec.author)}</cp:lastModifiedBy>` : ''}${date ? `<dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified>` : ''}</cp:coreProperties>`;
  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NEAR AI for VS Code</Application></Properties>`;
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>`
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
    + (notesXml ? `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/>` : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const notePr = !notesXml ? '' : kind === 'footnote' ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : '<w:endnotePr><w:numFmt w:val="decimal"/><w:endnote w:id="-1"/><w:endnote w:id="0"/></w:endnotePr>';
  const settings = `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/>${notePr}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  const documentRels = relationships([
    { id: 'rId1', type: `${REL}/styles`, target: 'styles.xml' },
    { id: 'rId2', type: `${REL}/settings`, target: 'settings.xml' },
    { id: 'rId3', type: `${REL}/numbering`, target: 'numbering.xml' },
    { id: 'rId4', type: `${REL}/footer`, target: 'footer1.xml' },
    ...(notesXml ? [{ id: 'rId5', type: `${REL}/${kind}s`, target: `${kind}s.xml` }] : []),
    ...builder.rels
  ]);
  const packageRels = relationships([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' }
  ]);
  const text = (value: string) => Buffer.from(value, 'utf8');
  const bytes = writeZip([
    ['[Content_Types].xml', text(types)],
    ['_rels/.rels', text(packageRels)],
    ['docProps/core.xml', text(core)],
    ['docProps/app.xml', text(app)],
    ['word/document.xml', text(document)],
    ['word/_rels/document.xml.rels', text(documentRels)],
    ['word/styles.xml', text(styles())],
    ['word/settings.xml', text(settings)],
    ['word/numbering.xml', text(numbering(builder.numbering))],
    ['word/footer1.xml', text(footer)],
    ...(notesXml ? [[`word/${kind}s.xml`, text(notesXml)] as [string, Buffer]] : []),
    ...(builder.noteRels.length ? [[`word/_rels/${kind}s.xml.rels`, text(relationships(builder.noteRels))] as [string, Buffer]] : []),
    ...builder.media.map((item): [string, Buffer] => [`word/media/${item.name}`, item.bytes])
  ]);
  return { bytes, headings: builder.headings, tables: builder.tables, images: builder.media.length, notes: notes.length };
}
