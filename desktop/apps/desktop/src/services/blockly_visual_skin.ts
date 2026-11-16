import type { BlocklyVisualStyle } from './blockly_visual_style';

/**
 * The CK blocks intentionally keep Blockly's normal colour/connection model.
 * Blockly 12 renders many CK blocks from a numeric `setColour()` call, so a
 * theme `blockStyles` table cannot reliably recolour those blocks.  This
 * painter works on the already-rendered SVG instead.  It changes paint only:
 * no block model, XML, geometry, renderer or generated source is touched.
 */

type SvgLike = Element & {
    style: CSSStyleDeclaration;
    dataset: DOMStringMap;
};

type BlockLike = {
    type?: string;
    getSvgRoot?: () => Element | null;
    getColour?: () => string;
    getColourSecondary?: () => string;
    isShadow?: () => boolean;
};

type WorkspaceLike = {
    getAllBlocks?: (ordered?: boolean) => BlockLike[];
    getParentSvg?: () => Element | null;
    getToolbox?: () => {
        getFlyout?: () => { getWorkspace?: () => WorkspaceLike | null } | null;
    } | null;
    getFlyout?: () => { getWorkspace?: () => WorkspaceLike | null } | null;
};

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };
type SkinColourRole = 'hat' | 'logic' | 'loop' | 'hardware' | 'time' | 'text' | 'math' | 'variable' | 'network' | 'serial' | 'sound';

const SVG_COLOUR_RE = /^#([0-9a-f]{3,8})$/i;
const RGB_COLOUR_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+[\d.]+%?)?\s*\)$/i;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const svgPaintScopes = new WeakMap<SVGSVGElement, string>();
let nextSvgPaintScope = 0;

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

const parseColour = (value: unknown): Rgb | null => {
    const raw = String(value ?? '').trim();
    const hex = raw.match(SVG_COLOUR_RE);
    if (hex) {
        let digits = hex[1];
        if (digits.length === 3 || digits.length === 4) {
            digits = digits.split('').map(char => `${char}${char}`).join('');
        }
        if (digits.length < 6) return null;
        const number = Number.parseInt(digits.slice(0, 6), 16);
        if (!Number.isFinite(number)) return null;
        return {
            r: (number >> 16) & 0xff,
            g: (number >> 8) & 0xff,
            b: number & 0xff,
        };
    }
    const rgb = raw.match(RGB_COLOUR_RE);
    if (!rgb) return null;
    const values = rgb.slice(1, 4).map(Number);
    if (values.some(value => !Number.isFinite(value))) return null;
    return { r: values[0], g: values[1], b: values[2] };
};

const rgbToHsl = ({ r, g, b }: Rgb): Hsl => {
    const red = clamp(r / 255);
    const green = clamp(g / 255);
    const blue = clamp(b / 255);
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: lightness };

    const delta = max - min;
    const saturation = lightness > 0.5
        ? delta / (2 - max - min)
        : delta / (max + min);
    let hue: number;
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    return { h: hue * 60, s: saturation, l: lightness };
};

const hueToRgb = (p: number, q: number, t: number): number => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
};

const hslToRgb = ({ h, s, l }: Hsl): Rgb => {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s <= 0.0001) {
        const value = Math.round(clamp(l) * 255);
        return { r: value, g: value, b: value };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
        r: Math.round(clamp(hueToRgb(p, q, hue + 1 / 3)) * 255),
        g: Math.round(clamp(hueToRgb(p, q, hue)) * 255),
        b: Math.round(clamp(hueToRgb(p, q, hue - 1 / 3)) * 255),
    };
};

const rgbToHex = ({ r, g, b }: Rgb): string => `#${[r, g, b]
    .map(value => Math.round(clamp(value / 255) * 255).toString(16).padStart(2, '0'))
    .join('')}`;

const mix = (left: Rgb, right: Rgb, amount: number): Rgb => ({
    r: left.r + (right.r - left.r) * amount,
    g: left.g + (right.g - left.g) * amount,
    b: left.b + (right.b - left.b) * amount,
});

const mixHex = (colour: string, target: Rgb, amount: number): string => {
    const parsed = parseColour(colour);
    return parsed ? rgbToHex(mix(parsed, target, amount)) : colour;
};

const relativeLuminance = ({ r, g, b }: Rgb): number => {
    const linear = [r, g, b].map(channel => {
        const value = clamp(channel / 255);
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrastRatio = (left: Rgb, right: Rgb): number => {
    const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
};

const readableBlockText = (colour: string): string => {
    const parsed = parseColour(colour);
    if (!parsed) return '#ffffff';
    // Near-black and pure white close the small WCAG gap left by softer UI
    // colours: for every CK role colour at least one side remains >= 4.5:1.
    const light = { r: 255, g: 255, b: 255 };
    const dark = { r: 5, g: 7, b: 11 };
    return contrastRatio(parsed, light) >= contrastRatio(parsed, dark) ? '#ffffff' : '#05070b';
};

export const resolveBlocklySkinLabelSurface = (colour: string, style: BlocklyVisualStyle): string => (
    style === 'neon'
        ? mixHex(colour, { r: 3, g: 10, b: 26 }, 0.36)
        : style === 'arcade'
            ? mixHex(colour, { r: 0, g: 0, b: 0 }, 0.12)
            : style === 'mono'
                ? mixHex(colour, { r: 0, g: 0, b: 0 }, 0.06)
                : colour
);

const SKIN_BLOCK_LABEL_COLOURS: Record<BlocklyVisualStyle, string> = {
    original: '#ffffff',
    pastel: '#05070b',
    arcade: '#ffffff',
    sticker: '#ffffff',
    neon: '#ffffff',
    mono: '#05070b',
};

export const resolveBlocklySkinTextColour = (
    colour: string,
    style: BlocklyVisualStyle,
): string => style === 'original'
    ? readableBlockText(resolveBlocklySkinLabelSurface(colour, style))
    : SKIN_BLOCK_LABEL_COLOURS[style];

const ensureStableSkinLabelContrast = (
    colour: string,
    style: BlocklyVisualStyle,
): string => {
    if (style === 'original') return colour;
    let adjusted = parseColour(colour);
    const text = parseColour(SKIN_BLOCK_LABEL_COLOURS[style]);
    if (!adjusted || !text) return colour;
    const adjustmentTarget = relativeLuminance(text) > 0.5
        ? { r: 0, g: 0, b: 0 }
        : { r: 255, g: 255, b: 255 };

    // A skin owns one stable body-label colour. Nudge only the few category
    // swatches that would otherwise fall below readable contrast instead of
    // flipping individual blocks between black and white.
    for (let step = 0; step < 24; step += 1) {
        const adjustedHex = rgbToHex(adjusted);
        const surface = parseColour(resolveBlocklySkinLabelSurface(adjustedHex, style));
        if (surface && contrastRatio(surface, text) >= 4.5) return adjustedHex;
        adjusted = mix(adjusted, adjustmentTarget, 0.055);
    }
    return rgbToHex(adjusted);
};

const appendGradientStop = (
    gradient: SVGLinearGradientElement,
    offset: string,
    colour: string,
    opacity?: string,
): void => {
    const stop = document.createElementNS(SVG_NAMESPACE, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', colour);
    if (opacity) stop.setAttribute('stop-opacity', opacity);
    gradient.appendChild(stop);
};

const svgPaintScope = (svg: SVGSVGElement): string => {
    const existing = svgPaintScopes.get(svg);
    if (existing) return existing;
    nextSvgPaintScope += 1;
    const scope = `ck-skin-${nextSvgPaintScope}`;
    svgPaintScopes.set(svg, scope);
    return scope;
};

const skinDefs = (svg: SVGSVGElement): SVGDefsElement => {
    const existing = Array.from(svg.children).find(child => (
        child.tagName.toLowerCase() === 'defs' && child.getAttribute('data-ck-block-skin-defs') === 'true'
    ));
    if (existing) return existing as SVGDefsElement;
    const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
    defs.setAttribute('data-ck-block-skin-defs', 'true');
    svg.insertBefore(defs, svg.firstChild);
    return defs;
};

/**
 * Give the skins genuinely different material treatments without touching
 * block geometry.  Pastel stays flat, arcade gets a stepped toy-like bevel,
 * sticker gets a quiet paper grain, neon gets a dark luminous body, and mono
 * gets a restrained graphite gradient.
 */
const skinPathFill = (
    path: Element,
    colour: string,
    style: BlocklyVisualStyle,
): string => {
    if (style === 'original' || style === 'pastel') return colour;
    const svg = (path as SVGGraphicsElement).ownerSVGElement;
    const parsed = parseColour(colour);
    if (!svg || !parsed) return colour;

    const safeColour = colour.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const id = `${svgPaintScope(svg)}-${style}-${safeColour}`;
    if (svg.querySelector(`[id="${id}"]`)) return `url(#${id})`;

    const defs = skinDefs(svg);
    if (style === 'sticker') {
        const pattern = document.createElementNS(SVG_NAMESPACE, 'pattern');
        pattern.setAttribute('id', id);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('width', '10');
        pattern.setAttribute('height', '10');

        const base = document.createElementNS(SVG_NAMESPACE, 'rect');
        base.setAttribute('width', '10');
        base.setAttribute('height', '10');
        base.setAttribute('fill', colour);
        pattern.appendChild(base);

        const fibre = document.createElementNS(SVG_NAMESPACE, 'path');
        fibre.setAttribute('d', 'M1 2h2 M6 7h2 M3 9h1');
        fibre.setAttribute('stroke', '#fff8e8');
        fibre.setAttribute('stroke-width', '0.55');
        fibre.setAttribute('stroke-linecap', 'round');
        fibre.setAttribute('opacity', '0.34');
        pattern.appendChild(fibre);

        const speck = document.createElementNS(SVG_NAMESPACE, 'circle');
        speck.setAttribute('cx', '8');
        speck.setAttribute('cy', '2');
        speck.setAttribute('r', '0.55');
        speck.setAttribute('fill', mixHex(colour, { r: 45, g: 35, b: 28 }, 0.42));
        speck.setAttribute('opacity', '0.22');
        pattern.appendChild(speck);
        defs.appendChild(pattern);
        return `url(#${id})`;
    }

    const gradient = document.createElementNS(SVG_NAMESPACE, 'linearGradient');
    gradient.setAttribute('id', id);
    gradient.setAttribute('x1', '0');
    gradient.setAttribute('x2', '0');
    gradient.setAttribute('y1', '0');
    gradient.setAttribute('y2', '1');
    if (style === 'arcade') {
        appendGradientStop(gradient, '0%', mixHex(colour, { r: 255, g: 255, b: 255 }, 0.2));
        appendGradientStop(gradient, '46%', colour);
        appendGradientStop(gradient, '51%', mixHex(colour, { r: 0, g: 0, b: 0 }, 0.13));
        appendGradientStop(gradient, '100%', mixHex(colour, { r: 0, g: 0, b: 0 }, 0.26));
    } else if (style === 'neon') {
        appendGradientStop(gradient, '0%', mixHex(colour, { r: 3, g: 10, b: 26 }, 0.46));
        appendGradientStop(gradient, '48%', mixHex(colour, { r: 3, g: 10, b: 26 }, 0.24));
        appendGradientStop(gradient, '100%', mixHex(colour, { r: 0, g: 0, b: 0 }, 0.48));
    } else {
        appendGradientStop(gradient, '0%', mixHex(colour, { r: 255, g: 255, b: 255 }, 0.12));
        appendGradientStop(gradient, '100%', mixHex(colour, { r: 0, g: 0, b: 0 }, 0.12));
    }
    defs.appendChild(gradient);
    return `url(#${id})`;
};

const SKIN_ROLE_COLOURS: Record<Exclude<BlocklyVisualStyle, 'original'>, Record<SkinColourRole, string>> = {
    pastel: {
        hat: '#52ae8d',
        logic: '#6687cf',
        loop: '#9272c0',
        hardware: '#4f9f9b',
        time: '#b9831f',
        text: '#d48652',
        math: '#84ac48',
        variable: '#ce6f95',
        network: '#589ac8',
        serial: '#5f88c5',
        sound: '#cb688e',
    },
    arcade: {
        hat: '#efb300',
        logic: '#e47c16',
        loop: '#d87012',
        hardware: '#008e89',
        time: '#dfa000',
        text: '#bb3bc7',
        math: '#78b82c',
        variable: '#b63abb',
        network: '#237dd0',
        serial: '#008b91',
        sound: '#a92aa7',
    },
    sticker: {
        hat: '#6679aa',
        logic: '#627caf',
        loop: '#825493',
        hardware: '#4d8581',
        time: '#a97925',
        text: '#b86f3d',
        math: '#6f8f41',
        variable: '#aa5576',
        network: '#56829b',
        serial: '#4d8188',
        sound: '#a95774',
    },
    neon: {
        hat: '#6778e8',
        logic: '#3475da',
        loop: '#9852db',
        hardware: '#00aaa3',
        time: '#d7a51e',
        text: '#dd6543',
        math: '#96bd21',
        variable: '#dc4c91',
        network: '#2797d5',
        serial: '#009fbd',
        sound: '#bf4bd8',
    },
    mono: {
        hat: '#8794a7',
        logic: '#66758a',
        loop: '#8a8f99',
        hardware: '#737f86',
        time: '#a8a29a',
        text: '#928b83',
        math: '#a7adb2',
        variable: '#8d8992',
        network: '#75848e',
        serial: '#6e7e86',
        sound: '#91868e',
    },
};

const blockSkinRole = (blockType: unknown): SkinColourRole | null => {
    const type = String(blockType ?? '').trim().toLowerCase();
    if (!type) return null;
    if (/(?:tone|buzzer|music|sound|speaker|melody|note)/.test(type)) return 'sound';
    if (/(?:wifi|network|http|mqtt|bluetooth|\bble\b|websocket|ethernet)/.test(type)) return 'network';
    if (/(?:delay|wait|millis|micros|timer|timing|clock|time_)/.test(type)) return 'time';
    if (/(?:setup|start|event|when_|hat)/.test(type)) return 'hat';
    if (/(?:repeat|while|foreach|for_each|controls_for|controls_flow|\bloop\b|loop_)/.test(type)) return 'loop';
    if (/(?:controls_if|logic_|compare|boolean|condition|switch|case_)/.test(type)) return 'logic';
    if (/(?:serial|uart)/.test(type)) return 'serial';
    if (/(?:pin|digital|analog|pwm|i2c|spi|wire|sensor|motor|servo|relay|mpu|oled|dht|ultrasonic|ck_hw|ck_common|gpio|led)/.test(type)) return 'hardware';
    if (/(?:text|string|char)/.test(type)) return 'text';
    if (/(?:math|number|random|constrain|map_range)/.test(type)) return 'math';
    if (/(?:variable|list|array)/.test(type)) return 'variable';
    return null;
};

export const resolveBlocklySkinColour = (
    baseColour: string,
    blockType: unknown,
    style: BlocklyVisualStyle,
): string => {
    if (style === 'original') return baseColour;
    const role = blockSkinRole(blockType);
    const transformed = role ? SKIN_ROLE_COLOURS[style][role] : transformBlocklyBlockColour(baseColour, style);
    return ensureStableSkinLabelContrast(transformed, style);
};

/**
 * Transform one block's base colour for a skin.  The transforms are
 * deliberately deterministic and category-preserving: blue remains in the
 * blue family, green remains in the green family, etc., while the skin gets a
 * visibly different palette.
 */
export const transformBlocklyBlockColour = (
    baseColour: string,
    style: BlocklyVisualStyle,
): string => {
    if (style === 'original') return baseColour;
    const parsed = parseColour(baseColour);
    if (!parsed) return baseColour;
    const baseHsl = rgbToHsl(parsed);
    let transformed: Rgb;

    switch (style) {
        case 'pastel': {
            // Soft, milky colours like the light teaching reference, without
            // flattening category hues into one tint.
            const hsl = {
                h: baseHsl.h,
                s: clamp(baseHsl.s * 0.68),
                l: clamp(baseHsl.l + 0.14, 0.38, 0.84),
            };
            transformed = mix(hslToRgb(hsl), { r: 255, g: 255, b: 255 }, 0.16);
            break;
        }
        case 'arcade': {
            // Saturated, slightly darker pixel-console colours with strong
            // separation from the dark workspace.
            transformed = hslToRgb({
                h: baseHsl.h,
                s: clamp(Math.max(baseHsl.s, 0.52) * 1.34),
                l: clamp(baseHsl.l * 0.82, 0.28, 0.64),
            });
            break;
        }
        case 'sticker': {
            // Warm paper treatment: a small hue shift and a cream mix give
            // the hand-cut sticker look while preserving category contrast.
            const hsl = {
                h: baseHsl.h + 5,
                s: clamp(baseHsl.s * 0.78),
                l: clamp(baseHsl.l + 0.08, 0.38, 0.78),
            };
            transformed = mix(hslToRgb(hsl), { r: 255, g: 248, b: 232 }, 0.13);
            break;
        }
        case 'neon': {
            transformed = hslToRgb({
                h: baseHsl.h,
                s: clamp(Math.max(baseHsl.s, 0.58) * 1.52),
                l: clamp(baseHsl.l + (baseHsl.l < 0.5 ? 0.08 : 0.01), 0.42, 0.72),
            });
            break;
        }
        case 'mono': {
            transformed = hslToRgb({
                h: 0,
                s: 0,
                l: clamp(baseHsl.l * 0.88 + 0.08, 0.28, 0.78),
            });
            break;
        }
        default:
            transformed = parsed;
            break;
    }
    return ensureStableSkinLabelContrast(rgbToHex(transformed), style);
};

/**
 * Shadow blocks are Blockly's default placeholders.  They must keep the same
 * semantic hue as the real block while remaining visibly subordinate.  The
 * direction of the neutral shift follows the skin's fixed label ink so the
 * placeholder never becomes unreadable in either application theme.
 */
export const resolveBlocklyShadowSkinColour = (
    colour: string,
    style: BlocklyVisualStyle,
): string => {
    if (style === 'original') return colour;
    const parsed = parseColour(colour);
    const label = parseColour(SKIN_BLOCK_LABEL_COLOURS[style]);
    if (!parsed || !label) return colour;
    const hsl = rgbToHsl(parsed);
    const quiet = hslToRgb({
        h: hsl.h,
        s: hsl.s * (style === 'mono' ? 0.12 : 0.36),
        l: hsl.l,
    });
    const lightLabel = relativeLuminance(label) > 0.5;
    const target = lightLabel
        ? { r: 15, g: 23, b: 42 }
        : { r: 241, g: 245, b: 249 };
    const amount: Record<Exclude<BlocklyVisualStyle, 'original'>, number> = {
        pastel: 0.26,
        arcade: 0.3,
        sticker: 0.28,
        neon: 0.34,
        mono: 0.22,
    };
    return ensureStableSkinLabelContrast(rgbToHex(mix(quiet, target, amount[style])), style);
};

const isElement = (value: unknown): value is Element => (
    !!value && typeof value === 'object' && typeof (value as Element).classList?.contains === 'function'
);

const directMainPath = (root: Element): SvgLike | null => {
    for (const child of Array.from(root.children)) {
        if (isElement(child) && child.classList.contains('blocklyPath')) {
            return child as SvgLike;
        }
    }
    return null;
};

const addWorkspace = (target: WorkspaceLike | null | undefined, list: WorkspaceLike[], seen: Set<WorkspaceLike>): void => {
    if (!target || seen.has(target)) return;
    seen.add(target);
    list.push(target);
    try {
        addWorkspace(target.getToolbox?.()?.getFlyout?.()?.getWorkspace?.(), list, seen);
        addWorkspace(target.getFlyout?.()?.getWorkspace?.(), list, seen);
    } catch {
        // A flyout may be in the middle of being replaced; the main workspace
        // is still safe to paint in that case.
    }
};

const safeColour = (block: BlockLike | undefined): string | null => {
    try {
        const value = block?.getColour?.();
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
        return null;
    }
};

const safeSecondaryColour = (block: BlockLike | undefined): string | null => {
    try {
        const value = block?.getColourSecondary?.();
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
        return null;
    }
};

const isShadowBlock = (root: Element, block: BlockLike | undefined): boolean => {
    try {
        if (block?.isShadow?.()) return true;
    } catch {
        // A block may be disposing while its SVG is still present.  The root
        // class remains a reliable fallback for that frame.
    }
    return root.classList.contains('blocklyShadow');
};

const rememberBaseColour = (path: SvgLike, candidate: string | null): string | null => {
    if (candidate) {
        path.dataset.ckBaseFill = candidate;
        return candidate;
    }
    const remembered = path.dataset.ckBaseFill;
    if (remembered) return remembered;
    const attr = path.getAttribute('fill');
    if (attr && attr !== 'none') {
        path.dataset.ckBaseFill = attr;
        return attr;
    }
    return null;
};

const rememberShadowColour = (path: SvgLike, candidate: string | null): string | null => {
    if (candidate) {
        path.dataset.ckBaseShadowFill = candidate;
        return candidate;
    }
    const remembered = path.dataset.ckBaseShadowFill;
    if (remembered) return remembered;
    const attr = path.getAttribute('fill');
    if (attr && attr !== 'none' && !/^url\(#ck-skin-/i.test(attr)) {
        path.dataset.ckBaseShadowFill = attr;
        return attr;
    }
    return null;
};

const paintFieldSurfaces = (root: Element, style: BlocklyVisualStyle): void => {
    const selector = [
        '.blocklyEditableField > rect',
        '.blocklyNonEditableField > rect',
        '.blocklyDropdownField > .blocklyDropdownRect',
    ].join(', ');
    // A Blockly stack nests every following block below its SVG root. Walking
    // the entire subtree for every block repaints the same fields quadratically.
    // Each child block is painted separately: visit only this block's own DOM.
    const fields: SvgLike[] = [];
    const walker = root.ownerDocument.createTreeWalker(root, 1, {
        acceptNode: node => (node as Element).classList.contains('blocklyBlock') ? 2 : 1,
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if ((node as Element).matches(selector)) fields.push(node as SvgLike);
    }
    fields.forEach((field) => {
        if (!field.dataset.ckBaseFieldFill) {
            field.dataset.ckBaseFieldFill = field.getAttribute('fill') || '';
            field.dataset.ckBaseFieldStroke = field.getAttribute('stroke') || '';
            field.dataset.ckBaseFieldStrokeWidth = field.getAttribute('stroke-width') || '';
            field.dataset.ckBaseFieldRx = field.getAttribute('rx') || '';
            field.dataset.ckBaseFieldRy = field.getAttribute('ry') || '';
        }
        const restore = () => {
            const fill = field.dataset.ckBaseFieldFill;
            const stroke = field.dataset.ckBaseFieldStroke;
            const width = field.dataset.ckBaseFieldStrokeWidth;
            const rx = field.dataset.ckBaseFieldRx;
            const ry = field.dataset.ckBaseFieldRy;
            if (fill) field.setAttribute('fill', fill); else field.removeAttribute('fill');
            if (stroke) field.setAttribute('stroke', stroke); else field.removeAttribute('stroke');
            if (width) field.setAttribute('stroke-width', width); else field.removeAttribute('stroke-width');
            if (rx) field.setAttribute('rx', rx); else field.removeAttribute('rx');
            if (ry) field.setAttribute('ry', ry); else field.removeAttribute('ry');
            field.style.removeProperty('fill');
            field.style.removeProperty('stroke');
            field.style.removeProperty('stroke-width');
        };
        if (style === 'original') {
            restore();
            return;
        }
        let fill = '#f8fafc';
        let stroke = '#cbd5e1';
        let width = '1';
        let radius = '5';
        switch (style) {
            case 'pastel':
                fill = '#fffaf2';
                stroke = '#718399';
                radius = '8';
                break;
            case 'arcade':
                fill = '#101a2e';
                stroke = '#f8d36b';
                width = '1.5';
                radius = '2';
                break;
            case 'sticker':
                fill = '#fff4df';
                stroke = '#756255';
                width = '1.2';
                radius = '7';
                break;
            case 'neon':
                fill = '#07152b';
                stroke = '#71e7db';
                width = '1.25';
                radius = '4';
                break;
            case 'mono':
                fill = '#edf0f3';
                stroke = '#667085';
                radius = '3';
                break;
            default:
                break;
        }
        field.style.setProperty('fill', fill, 'important');
        field.style.setProperty('stroke', stroke, 'important');
        field.style.setProperty('stroke-width', width, 'important');
        field.setAttribute('rx', radius);
        field.setAttribute('ry', radius);
    });
};

const paintRoot = (root: Element, block: BlockLike | undefined, style: BlocklyVisualStyle): boolean => {
    // A block's visual identity must not depend on whether it can be dragged.
    // Read-only previews and locked blocks keep `.blocklyBlock` but deliberately
    // omit `.blocklyDraggable`; they still need the same global skin treatment.
    if (!root.classList.contains('blocklyBlock') || root.classList.contains('blocklyInsertionMarker')) return false;
    const path = directMainPath(root);
    if (!path) return false;
    // Fresh original-style blocks are already correctly painted by Blockly.
    // Restore only roots that CK has previously styled, never rewrite a fresh
    // 50k-block workspace just to apply the same native attributes again.
    if (style === 'original' && !path.dataset.ckVisualStyle) return false;
    const shadow = isShadowBlock(root, block);
    const base = rememberBaseColour(path, safeColour(block));
    if (!base) return false;
    const shadowBase = shadow ? rememberShadowColour(path, safeSecondaryColour(block)) : null;
    const regularColour = resolveBlocklySkinColour(base, block?.type, style);
    const transformed = shadow
        ? style === 'original'
            ? shadowBase || regularColour
            : resolveBlocklyShadowSkinColour(regularColour, style)
        : regularColour;
    const surfaceFill = skinPathFill(path, transformed, style);
    path.setAttribute('fill', surfaceFill);
    if (style === 'original') path.style.removeProperty('fill');
    else path.style.setProperty('fill', surfaceFill, 'important');
    path.dataset.ckVisualStyle = style;
    path.dataset.ckShadowBlock = shadow ? 'true' : 'false';
    const rootStyle = (root as SvgLike).style;
    if (style === 'original') {
        rootStyle.removeProperty('--ck-block-skin-accent');
        rootStyle.removeProperty('--ck-block-skin-label');
        rootStyle.removeProperty('--ck-block-skin-surface');
    } else {
        const labelSurface = resolveBlocklySkinLabelSurface(transformed, style);
        rootStyle.setProperty(
            '--ck-block-skin-accent',
            mixHex(transformed, { r: 255, g: 255, b: 255 }, style === 'neon' ? 0.42 : 0.18),
        );
        rootStyle.setProperty('--ck-block-skin-label', resolveBlocklySkinTextColour(transformed, style));
        rootStyle.setProperty('--ck-block-skin-surface', labelSurface);
    }
    paintFieldSurfaces(root, style);
    return true;
};

/**
 * Paint all rendered blocks in a main Blockly workspace and its flyout.
 * Returns the number of block roots painted, useful for diagnostics/tests.
 */
export const applyBlocklyVisualSkin = (
    workspace: WorkspaceLike | null | undefined,
    style: BlocklyVisualStyle,
): number => {
    if (!workspace) return 0;
    const workspaces: WorkspaceLike[] = [];
    addWorkspace(workspace, workspaces, new Set<WorkspaceLike>());
    const blockToRoot = new Map<Element, BlockLike>();
    let painted = 0;

    workspaces.forEach((target) => {
        const blocks = target.getAllBlocks?.(false) || [];
        blocks.forEach((block) => {
            const root = block.getSvgRoot?.();
            if (!root) return;
            blockToRoot.set(root, block);
            if (paintRoot(root, block, style)) painted += 1;
        });
    });

    // During a toolbox refresh the flyout model can exist one frame before its
    // block list is registered. Querying the rendered SVG closes that race.
    workspaces.forEach((target) => {
        const parent = target.getParentSvg?.();
        if (!parent) return;
        const roots = Array.from(parent.querySelectorAll('.blocklyBlock'));
        roots.forEach((root) => {
            // Model-backed roots were already painted above. Repainting every
            // field here doubled the cost of each workspace-wide refresh.
            if (blockToRoot.has(root)) return;
            if (paintRoot(root, undefined, style)) painted += 1;
        });
    });

    return painted;
};

/** Paint only changed block roots; descendants must be supplied explicitly. */
export const applyBlocklyVisualSkinToBlocks = (
    blocks: Iterable<BlockLike>,
    style: BlocklyVisualStyle,
): number => {
    let painted = 0;
    for (const block of blocks) {
        const root = block.getSvgRoot?.();
        if (root && paintRoot(root, block, style)) painted += 1;
    }
    return painted;
};

/** Mutation records already identify new SVG; no whole-workspace query needed. */
export const applyBlocklyVisualSkinToRoots = (
    roots: Iterable<Element>,
    style: BlocklyVisualStyle,
    resolveBlock?: (root: Element) => BlockLike | undefined,
): number => {
    let painted = 0;
    for (const root of roots) if (paintRoot(root, resolveBlock?.(root), style)) painted += 1;
    return painted;
};

export type BlocklyVisualSkinWorkspace = WorkspaceLike;
