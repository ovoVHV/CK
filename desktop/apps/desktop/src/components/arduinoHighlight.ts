import { cppLanguage } from '@codemirror/lang-cpp';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Prec, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { styleTags, tags as t } from '@lezer/highlight';
import { oneDarkTheme } from '@codemirror/theme-one-dark';

const directive = t.special(t.name);
const receiver = t.special(t.variableName);
export const arduinoCpp = cppLanguage.configure({ props: [styleTags({
    'PreprocDirective/Identifier': directive,
    'FunctionDeclarator/FieldIdentifier': t.function(t.propertyName),
    'FieldExpression/Identifier': receiver,
})] });
const palette = (dark: boolean) => {
    const color = (light: string, night: string) => dark ? night : light;
    return syntaxHighlighting(HighlightStyle.define([
        { tag: [t.variableName, t.propertyName], color: color('#254e87','#a9cfff') },
        { tag: [t.typeName,t.className,t.namespace,receiver], color: color('#116a68','#73d5c5') },
        { tag: [t.function(t.variableName),t.function(t.propertyName)], color: color('#805009','#f1cc80') },
        { tag: t.keyword, color: color('#793394','#dba7f1') },
        { tag: [t.bool,t.null,t.number,t.literal], color: color('#96501a','#f7ae78') },
        { tag: [t.string,t.character], color: color('#97512d','#ecc097') },
        { tag: [t.meta,directive], color: color('#962b63','#ff9ec9') },
        { tag: t.comment, color: color('#5b6c55','#a4b49b'), fontStyle:'italic' },
        { tag: t.operator, color: color('#535966','#b3bac8') },
    ]));
};
const palettes = [palette(false),palette(true)];
export const codeTheme = (dark:boolean) => [dark ? oneDarkTheme : [], palettes[Number(dark)]];
// The parser treats macro references as ordinary identifiers. Limit the convention
// to identifier nodes so strings, comments and inactive viewport text aren't scanned.
const constants = ['#962b63','#ff9ec9'].map(color=>Decoration.mark({class:'ck-cpp-constant',attributes:{style:`color:${color}`}}));
function constantRanges(view:EditorView) {
    const ranges = new RangeSetBuilder<Decoration>(), tree = syntaxTree(view.state);
    const constant=constants[Number(view.state.facet(EditorView.darkTheme))];
    for (const {from,to} of view.visibleRanges) tree.iterate({ from,to, enter(n) {
        if(n.name==='Identifier' && n.from>=from && n.from<to &&
            /^[A-Z][A-Z0-9_]+$/.test(view.state.sliceDoc(n.from,n.to))) ranges.add(n.from,n.to,constant);
    }});
    return ranges.finish();
}
export const cppConstants = Prec.highest(ViewPlugin.fromClass(class {
    decorations;
    constructor(view:EditorView){ this.decorations=constantRanges(view); }
    update(u:ViewUpdate){ if(u.docChanged || u.viewportChanged || u.state.facet(EditorView.darkTheme)!==u.startState.facet(EditorView.darkTheme) || syntaxTree(u.state)!==syntaxTree(u.startState)) this.decorations=constantRanges(u.view); }
},{decorations:p=>p.decorations}));
