import channel from '../update-protocol/channel.json' with {type:'json'};
const fromHex=value=>Uint8Array.from(value.match(/../g),x=>parseInt(x,16));

export async function verifyRelease(envelope, cryptoApi=globalThis.crypto) {
    if(typeof envelope?.payload!=='string'||envelope.payload.length>65536||!/^[a-f0-9]{128}$/i.test(envelope.signature||''))throw Error('Invalid release envelope');
    const key=await cryptoApi.subtle.importKey('raw',fromHex(channel.publicKey),{name:'Ed25519'},false,['verify']);
    if(!await cryptoApi.subtle.verify('Ed25519',key,fromHex(envelope.signature),new TextEncoder().encode(envelope.payload)))throw Error('Release signature mismatch');
    const release=JSON.parse(envelope.payload);
    if(release.schema!==1||release.app!=='ck-build-engine-v91'||release.channel!==channel.channel||release.target!=='windows-x86_64'||!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version))throw Error('Unsupported release');
    const expected=`${channel.downloadPrefix}${release.version}/CK-V${release.version}-Setup-x64.exe`;
    if(release.url!==expected||!Number.isSafeInteger(release.size)||release.size<=0||release.size>512*1024*1024||!/^[a-f0-9]{64}$/.test(release.sha256))throw Error('Invalid release artifact');
    if(typeof release.notes!=='string'||release.notes.length>32768)throw Error('Invalid release notes');
    return release;
}

export async function refreshRelease() {
    try {
        const response=await fetch(channel.endpoint,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw Error('Manifest unavailable');
        const release=await verifyRelease(await response.json());
        for(const el of document.querySelectorAll('[data-release-version]'))el.textContent=release.version;
        for(const el of document.querySelectorAll('[data-release-size]'))el.textContent=(release.size/1024/1024).toFixed(1);
        for(const el of document.querySelectorAll('[data-release-sha]'))el.textContent=release.sha256;
        for(const el of document.querySelectorAll('[data-release-notes]'))el.textContent=release.notes;
        for(const el of document.querySelectorAll('[data-download-file]'))el.href=release.url;
        for(const el of document.querySelectorAll('[data-release-status]'))el.textContent='已核对签名发布清单';
    } catch {
        for(const el of document.querySelectorAll('[data-release-status]'))el.textContent='当前显示随网页发布的已核验版本；更新检查暂不可用。';
    }
}
