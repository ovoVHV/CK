import fs from 'node:fs';
export const visualManifest=JSON.parse(fs.readFileSync(new URL('./media/manifest.json',import.meta.url),'utf8'));
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function visual(id,compact=false){
 const v=visualManifest.find(item=>item.id===id);if(!v)throw Error(`Unknown visual ${id}`);
 const source=`/assets/screens/${id}.webp`;
 return `<figure class="product-visual${compact?' compact-visual':''}"><a class="visual-open" href="${source}" data-visual-title="${escape(v.title)}" aria-label="放大查看：${escape(v.title)}"><img src="${source}" ${v.width>768?`srcset="/assets/screens/${id}-768.webp 768w, ${source} ${v.width}w"`:""} sizes="${compact?'(max-width:760px) calc(100vw - 44px), 560px':'(max-width:760px) calc(100vw - 44px), (max-width:1100px) 75vw, 930px'}" alt="${escape(v.alt)}" width="${v.width}" height="${v.height}" loading="lazy" decoding="async"><span class="visual-zoom" aria-hidden="true">查看大图 ↗</span></a><figcaption><span class="visual-source">${v.kind==='component-sample'?'实际组件 · 示例数据':v.kind==='simulated-transport'?'桌面界面 · 模拟通信':'CK 桌面截图'}</span><span>${escape(v.caption)}</span></figcaption></figure>`;
}
export const visualStories=`<div class="visual-stories">${[
 ['serial','把一串数字，看成变化趋势。','识别结构化串口数据，用曲线观察变化；设置阈值，记录触发前后的数据。','observe'],
 ['pins','引脚填在哪里，就从哪里检查。','按库声明读取引脚用途和能力，显示占用与未知项，并定位回对应积木。','checks'],
 ['debug','暂停之后，知道停在哪一步。','在适用程序中定位积木断点，继续或单步执行，观察设备回执。','observe'],
 ['core','从板卡配置，到核心版本。','集中管理 AVR 与 ESP32 环境，优先推荐已验证版本，也可以手动选择其他版本。','environment'],
].map(([id,title,desc,anchor])=>`<article class="visual-story">${visual(id,true)}<div class="visual-story-copy"><h3>${title}</h3><p>${desc}</p><a class="text-link" href="/features/#${anchor}">了解功能与使用条件 ↗</a></div></article>`).join('')}</div>`;
