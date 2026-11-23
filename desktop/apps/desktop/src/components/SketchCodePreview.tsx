import { useLayoutEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { arduinoCpp, codeTheme, cppConstants } from './arduinoHighlight';

// CodeMirror virtualizes the viewport even for large generated sketches.
export function SketchCodePreview({code,dark}:{code:string;dark:boolean}) {
    const mount=useRef<HTMLDivElement>(null), view=useRef<EditorView|null>(null), theme=useRef(new Compartment());
    useLayoutEffect(()=>{
        const editor=new EditorView({parent:mount.current!, doc:code, extensions:[
            arduinoCpp,cppConstants,theme.current.of(codeTheme(dark)),lineNumbers(),
            EditorState.readOnly.of(true),EditorView.editable.of(false),
            EditorView.contentAttributes.of({'aria-label':'积木生成的 C++ 源码',tabindex:'0'}),
            EditorView.theme({'&':{height:'100%'},'.cm-scroller':{overflow:'auto',fontFamily:'Consolas, monospace',lineHeight:'1.65'},
                '.cm-content':{padding:'12px 0'},'.cm-gutters':{background:'transparent',border:'none',color:'#788596'}}),
        ]});view.current=editor;return ()=>{view.current=null;editor.destroy();};
    },[]);
    useLayoutEffect(()=>{const e=view.current;if(e&&code!==e.state.doc.toString())e.dispatch({changes:{from:0,to:e.state.doc.length,insert:code}});},[code]);
    useLayoutEffect(()=>{view.current?.dispatch({effects:theme.current.reconfigure(codeTheme(dark))});},[dark]);
    return <div className="h-full min-w-0" ref={mount} />;
}
