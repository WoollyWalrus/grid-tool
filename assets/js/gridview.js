/*
 * Draws a grid page as a preview, close to how Grid 3 shows it, with
 * spelling mistakes marked. Layout and styles come from gridmodel.mjs.
 */
import { resolveStyle, cssColour, pictureSource } from './gridmodel.mjs';

// Grid 3 font sizes are points on a typical 1366-pixel-wide screen. The
// preview scales them with its own width (cqi units).
const FONT_SCALE = (1.333 / 1366) * 100;

// Corner rounding for each BackgroundShape. Shapes the preview can't draw
// exactly (folder, hexagon, star…) are shown as rounded rectangles.
const RADIUS = { 0: '12%', 1: '28%', 2: '0', 3: '50%', 8: '18%', 10: '10%' };

const SPECIAL = {
  'AutoContent/Prediction': 'Prediction',
  'Workspace/Chat': 'Writing area',
  LiveCell: 'Live cell',
};

function el(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children.filter((c) => c != null));
  return node;
}

/** Text with marked ranges: [{ start, end, cls }] → nodes. */
function marked(text, marks = []) {
  const out = [];
  let last = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start < last) continue;
    out.push(text.slice(last, m.start), el('mark', m.cls, text.slice(m.start, m.end)));
    last = m.end;
  }
  out.push(text.slice(last));
  return out;
}

/**
 * options = {
 *   model, styles,
 *   text:     Map cellIndex → { text, marks } — replaces the caption shown
 *   flags:    Map cellIndex → { count, label } — cells with mistakes
 *   picture:  (fileName) → URL or null
 *   selected: cellIndex or null
 *   onSelect: (cellIndex) → void
 * }
 */
export function renderPage(options) {
  const { model, styles, text, flags, picture, selected, onSelect } = options;
  const board = el('div', 'gp-board');
  board.style.gridTemplateColumns = model.columns.map((w) => `${w}fr`).join(' ');
  board.style.gridTemplateRows = model.rows.map((h) => `${h}fr`).join(' ');
  board.style.background = cssColour(model.background) || '#e9e5ea';

  for (const cell of model.cells) {
    if (cell.x >= model.columns.length || cell.y >= model.rows.length) continue;
    const s = resolveStyle(cell.style, styles);
    const flag = flags.get(cell.index);
    const special = SPECIAL[`${cell.contentType}/${cell.contentSubType}`] || SPECIAL[cell.contentType];

    const tile = el('div', 'gp-cell');
    tile.style.gridColumn = `${cell.x + 1} / span ${Math.min(cell.w, model.columns.length - cell.x)}`;
    tile.style.gridRow = `${cell.y + 1} / span ${Math.min(cell.h, model.rows.length - cell.y)}`;
    if (cssColour(s.tile)) tile.style.background = cssColour(s.tile);
    if (['Hidden', 'Empty'].includes(cell.visibility)) tile.classList.add('is-hidden');
    if (cell.visibility === 'DeactivatedDimmed') tile.classList.add('is-dimmed');

    const shape = el('div', 'gp-shape');
    if (s.shape === 11) shape.classList.add('is-transparent');
    else {
      shape.style.background = cssColour(s.back) || '#fff';
      shape.style.borderColor = cssColour(s.border) || 'transparent';
    }
    shape.style.borderRadius = RADIUS[s.shape] ?? '18%';
    shape.style.color = cssColour(s.font) || '#000';
    shape.style.fontSize = `${(s.fontSize || 24) * FONT_SCALE}cqi`;

    const shown = text.get(cell.index);
    const captionText = shown ? shown.text : cell.caption;
    if (captionText) shape.append(el('span', 'gp-caption', ...marked(captionText, shown?.marks)));
    else if (special) shape.append(el('span', 'gp-special', special));

    const src = pictureSource(cell);
    if (src) {
      const url = src.kind === 'file' ? picture(src.name) : null;
      if (url) {
        const img = el('img', 'gp-picture');
        img.src = url;
        img.alt = '';
        shape.append(img);
      } else {
        const ph = el('span', 'gp-symbol');
        ph.title = src.kind === 'library' ? `Symbol from the ${src.library} library` : 'Picture the preview can\'t show';
        shape.append(ph);
      }
    }
    tile.append(shape);

    if (flag) {
      tile.classList.add('has-flag');
      tile.append(el('span', 'gp-badge', String(flag.count)));
    }
    if (flag || cell.jump || captionText) {
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', [captionText || special || 'Cell', flag?.label].filter(Boolean).join('. '));
      tile.addEventListener('click', () => onSelect(cell.index));
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(cell.index); }
      });
    }
    if (cell.index === selected) tile.classList.add('is-selected');
    tile.dataset.cell = String(cell.index);
    board.append(tile);
  }

  const frame = el('div', 'gp-frame', board);
  return frame;
}

/**
 * Grid 3 shrinks captions that don't fit. Call once the preview is on
 * screen; it steps each overflowing caption down until it fits.
 */
export function fitCaptions(frame) {
  for (const cap of frame.querySelectorAll('.gp-caption')) {
    const shape = cap.parentElement;
    let size = parseFloat(getComputedStyle(shape).fontSize);
    const hasPicture = shape.querySelector('.gp-picture, .gp-symbol');
    const limit = () => (hasPicture ? shape.clientHeight * 0.45 : shape.clientHeight);
    let guard = 30;
    const overflows = () => cap.scrollWidth > shape.clientWidth || cap.scrollHeight > limit();
    while (guard-- > 0 && size > 7 && overflows()) {
      size *= 0.88;
      shape.style.fontSize = `${size}px`;
    }
    // Words are only broken if the text still doesn't fit at the smallest size.
    if (overflows()) cap.classList.add('is-squashed');
  }
}
