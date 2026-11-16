const fs = require('fs');
const content = fs.readFileSync('index.css', 'utf-8');

// Find the start and end of the block
const startMarker = '.blocklyToolboxCategory {';
const endMarker = '.blocklyFlyoutBackground {';

const startIndex = content.indexOf('/* User Specified Larger Layout */');
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error('Markers not found!');
    process.exit(1);
}

const newStyles = \/* User Specified Larger Layout */
/* Mixly-style Toolbox Integration */

/* Category spacing and layout */
.blocklyToolboxCategory {
    margin-bottom: 4px !important;
    cursor: pointer !important;
}

/* Base style for the row. 
   IMPORTANT: DO NOT use !important on background-color here!
   Blockly dynamically applies inline 'background-color' upon selection 
   and 'border-left-color' on un-selection. */
.blocklyTreeRow {
    height: 44px !important;
    min-height: 44px !important;
    padding-left: 12px !important;
    width: 172px !important;
    margin-right: 8px !important;
    
    /* Mixly style: sharp edges, or maybe slight rounded */
    border-radius: 4px !important;
    border-left-width: 8px !important;
    border-left-style: solid !important;

    /* Base unselected background - Light gray */
    background-color: #f1f5f9;  /* fallback if blockly removes it inline */

    display: flex !important;
    align-items: center !important;
    
    color: #334155 !important;
    transition: all 0.1s ease;
}

/* The wrapper container - fixes gray bar gap by ensuring proper visibility */
.blocklyToolboxCategoryGroup {
    background-color: transparent !important;
    padding-bottom: 4px !important;
}

/* Hover state for unselected items */
.blocklyTreeRow:hover {
    background-color: #e2e8f0 !important;
}

/* SELECTED STATE:
   Blockly gives inline style="background-color: [COLOR]" to .blocklyTreeRow when selected.
   We just need to force the text and icon to white, and strip border-left (or let it match).
*/
.blocklyTreeRow.blocklyTreeSelected,
.blocklyTreeRow[aria-selected="true"] {
    color: #ffffff !important;
    /* Force border color to match the background, or eliminate it. */
    border-left-color: transparent !important;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1) !important;
}

/* Keep text white when selected */
.blocklyTreeRow.blocklyTreeSelected .blocklyToolboxCategoryLabel,
.blocklyTreeRow.blocklyTreeSelected .blocklyTreeLabel,
.blocklyTreeRow.blocklyTreeSelected span,
.blocklyTreeRow[aria-selected="true"] .blocklyToolboxCategoryLabel,
.blocklyTreeRow[aria-selected="true"] .blocklyTreeLabel,
.blocklyTreeRow[aria-selected="true"] span {
    color: #ffffff !important;
    -webkit-text-fill-color: #ffffff !important;
}

/* Invert SVG icons for selected categories */
.blocklyTreeRow.blocklyTreeSelected .blocklyToolboxCategoryLabel::before,
.blocklyTreeRow[aria-selected="true"] .blocklyToolboxCategoryLabel::before {
    opacity: 1;
    filter: brightness(0) saturate(100%) invert(100%) !important;
}

/* Dark Mode Overrides */
.dark .blocklyTreeRow {
    background-color: #1e293b;
    color: #cbd5e1 !important;
}

.dark .blocklyTreeRow:hover {
    background-color: #334155 !important;
}

.dark .blocklyTreeRow.blocklyTreeSelected,
.dark .blocklyTreeRow[aria-selected="true"] {
    color: #ffffff !important;
}

/* Fix Focus outlines */
.blocklyTreeRow:focus,
.blocklyTreeRow:active,
.blocklyTreeRow:focus-visible,
.blocklyToolboxCategory:focus,
.blocklyToolboxCategory:focus-visible,
.blocklyToolboxCategory:active {
    outline: none !important;
}

/* Fix vertical alignment for labels */
.blocklyTreeRowContentContainer {
    display: flex !important;
    align-items: center !important;
    height: 100% !important;
}

/* Layout for font */
.blocklyToolboxCategoryLabel,
.blocklyTreeLabel {
    font-family: inherit !important;
    font-size: 15px !important;
    font-weight: 600 !important;
    line-height: normal !important;
    padding-left: 6px;
}

\;

const newContent = content.substring(0, startIndex) + newStyles + content.substring(endIndex);
fs.writeFileSync('index.css', newContent, 'utf-8');
console.log('Update successful!');
