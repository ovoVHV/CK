import {useMemo} from 'react';
import {Virtuoso} from 'react-virtuoso';

/** Bound DOM size for generated sketches. Full text remains available to copy. */
export function LargeCodePreview({code}: {code:string}) {
    const lines=useMemo(()=>code.split('\n'),[code]);
    return <Virtuoso style={{height:'100%'}} totalCount={lines.length}
        fixedItemHeight={20} overscan={200}
        itemContent={index=><div style={{height:20,whiteSpace:'pre',display:'flex'}}>
            <span aria-hidden="true" style={{width:64,flexShrink:0,textAlign:'right',paddingRight:16,opacity:0.5,userSelect:'none'}}>{index+1}</span>
            <span>{lines[index] || ' '}</span>
        </div>} />;
}
