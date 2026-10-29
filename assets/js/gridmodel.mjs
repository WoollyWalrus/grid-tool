/*
 * Grid set Spell Checker — reading a grid page's layout and styles, so the
 * page can be drawn as a preview.
 *
 * Pure functions with no DOM access, so the same file runs in the page
 * and in Node (for the test suite).
 *
 * The preview is close to Grid 3, not identical: symbol library pictures
 * ([widgit], [grid3x]…) are not stored in grid sets, and Grid 3's own
 * fonts are not available in the browser.
 */

/*
 * Relative column widths and row heights. Grid 3 doesn't document these;
 * adjust them to match a screenshot of the same page in Grid 3.
 */
export const SIZES = { ExtraSmall: 0.5, Small: 0.75, Medium: 1, Large: 1.5, ExtraLarge: 2 };

/** Used for anything a style leaves out. */
const BASE_STYLE = {
  back: '#FFFFFFFF', border: '#C8C8C8FF', font: '#000000FF', tile: null,
  fontName: null, fontSize: 24, shape: 0, align: null,
};

/* ------------------------------------------------------------------ */
/* A minimal XML tree                                                  */
/* ------------------------------------------------------------------ */
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(ENTITY, (_, r) => r[0] === '#'
    ? String.fromCodePoint(r[1] === 'x' || r[1] === 'X' ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10))
    : NAMED[r.toLowerCase()]);
}

/** { name, attrs, children, text } — text is all direct text, CDATA included. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += decode(m[6]); continue; }
    if (!m[3]) continue;
    if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(m[4]))) attrs[a[1]] = decode(a[2] ?? a[3]);
    const node = { name: m[3], attrs, children: [], text: '' };
    top.children.push(node);
    if (m[5] !== '/') stack.push(node);
  }
  return root;
}

const child = (node, name) => node && node.children.find((c) => c.name === name);
const path = (node, ...names) => names.reduce((n, name) => child(n, name), node);
const value = (node, ...names) => {
  const n = path(node, ...names);
  return n ? n.text.trim() : null;
};

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */
function readStyle(node) {
  if (!node) return {};
  const s = {};
  const set = (key, v, f = (x) => x) => { if (v !== null && v !== '') s[key] = f(v); };
  set('back', value(node, 'BackColour'));
  set('border', value(node, 'BorderColour'));
  set('font', value(node, 'FontColour'));
  set('tile', value(node, 'TileColour'));
  set('fontName', value(node, 'FontName'));
  set('fontSize', value(node, 'FontSize'), Number);
  set('shape', value(node, 'BackgroundShape'), Number);
  set('align', value(node, 'Alignment'));
  return s;
}

/** styles.xml → Map of style key → style. */
export function parseStyles(xml) {
  const styles = new Map();
  const root = parseXml(xml);
  for (const s of path(root, 'StyleData', 'Styles')?.children || []) {
    if (s.name === 'Style' && s.attrs.Key) styles.set(s.attrs.Key, readStyle(s));
  }
  return styles;
}

/** The look of a cell: its named style, then anything set on the cell itself. */
export function resolveStyle(cellStyle, styles) {
  const named = styles.get(cellStyle.basedOn) || styles.get('Default') || {};
  return { ...BASE_STYLE, ...named, ...cellStyle.own };
}

/** "#RRGGBBAA" → "rgba(r, g, b, a)", or null if it isn't a colour. */
export function cssColour(c) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const alpha = m[2] ? parseInt(m[2], 16) / 255 : 1;
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${+alpha.toFixed(3)})`;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

/** Text from rich text (<p><s><r>…), paragraphs on separate lines. */
function richText(node) {
  if (!node) return '';
  const paragraphs = node.children.filter((c) => c.name === 'p');
  const runs = (n) => n.name === 'r' ? n.text : n.children.map(runs).join('');
  if (!paragraphs.length) return node.children.length ? runs(node) : node.text;
  return paragraphs.map(runs).join('\n');
}

/** The page a cell's Jump.To command opens, if any. */
function jumpTarget(content) {
  for (const cmd of path(content, 'Commands')?.children || []) {
    if (cmd.attrs.ID !== 'Jump.To') continue;
    const p = cmd.children.find((c) => c.name === 'Parameter' && c.attrs.Key === 'grid');
    if (p && p.text.trim()) return p.text.trim();
  }
  return null;
}

/**
 * grid.xml → {
 *   columns: [weight], rows: [weight], background,
 *   cells: [{ index, x, y, w, h, caption, image, style, contentType, contentSubType, visibility, jump }],
 *   wordList: [text],
 * }
 * Cells are numbered in file order, the same way gridtext.mjs numbers them.
 */
export function parseGrid(xml) {
  const grid = path(parseXml(xml), 'Grid');
  if (!grid) throw new Error('This page has no grid.');
  const sizes = (defs, attr) => (child(grid, defs)?.children || []).map((d) => SIZES[d.attrs[attr]] ?? 1);
  const columns = sizes('ColumnDefinitions', 'Width');
  const rows = sizes('RowDefinitions', 'Height');

  const cells = (child(grid, 'Cells')?.children || []).filter((c) => c.name === 'Cell').map((c, index) => {
    const content = child(c, 'Content');
    const styleNode = child(content, 'Style');
    return {
      index,
      x: +(c.attrs.X || 0),
      y: +(c.attrs.Y || 0),
      w: Math.max(1, +(c.attrs.ColumnSpan || 1)),
      h: Math.max(1, +(c.attrs.RowSpan || 1)),
      caption: value(content, 'CaptionAndImage', 'Caption') === null ? null : path(content, 'CaptionAndImage', 'Caption').text,
      image: value(content, 'CaptionAndImage', 'Image'),
      style: { basedOn: value(styleNode, 'BasedOnStyle'), own: readStyle(styleNode) },
      contentType: value(content, 'ContentType'),
      contentSubType: value(content, 'ContentSubType'),
      visibility: value(c, 'Visibility') || 'Visible',
      jump: jumpTarget(content),
    };
  });

  const items = path(grid, 'WordList', 'Items')?.children || [];
  const wordList = items.filter((i) => i.name === 'WordListItem').map((i) => richText(child(i, 'Text')));

  return { columns, rows, background: value(grid, 'BackgroundColour'), cells, wordList };
}

/**
 * Word list cells in the order Grid 3 fills them: along each row, top to
 * bottom. Returns cell indexes.
 */
export function wordListCells(model) {
  return model.cells
    .filter((c) => c.contentType === 'AutoContent' && c.contentSubType === 'WordList')
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((c) => c.index);
}

/**
 * A cell's picture reference → where it comes from:
 *   { kind: 'file', name }               a file stored next to grid.xml
 *   { kind: 'library', library, name }   a symbol library Grid 3 installs
 *
 * A cell's own picture is stored under its position: ".png" on the cell
 * in column 10, row 0 means the file "10-0.png", and "-0.png" means "10-0-0.png".
 */
export function pictureSource(cell) {
  const ref = cell.image;
  if (!ref) return null;
  const m = /^\[([^\]]+)\](.*)$/.exec(ref);
  if (m) return { kind: 'library', library: m[1].toLowerCase(), name: m[2] };
  const name = /^[.-]/.test(ref) ? `${cell.x}-${cell.y}${ref}` : ref;
  return { kind: 'file', name: name.replace(/\\/g, '/') };
}
