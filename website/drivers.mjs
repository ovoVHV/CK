import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export const driverCatalog=JSON.parse(fs.readFileSync(path.join(root,'drivers-catalog.json'),'utf8'));
const e=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size=n=>n<1048576?(n/1024).toFixed(0)+' KiB':(n/1048576).toFixed(1)+' MiB';
const download=(r,label)=>`<a class="button orange compact" data-driver-download href="${e(r.url)}" download="${e(r.file)}">${label} <span aria-hidden="true">↓</span></a>`;
export function stageDrivers(out){
 for(const r of [...driverCatalog.packages,driverCatalog.bundle]){
  if(!/^[a-zA-Z0-9._-]+$/.test(r.file)||r.url!='/downloads/drivers/'+r.file)throw Error('Invalid driver filename');
  const file=path.join(root,'downloads/drivers',r.file),data=fs.readFileSync(file);
  if(data.length!==r.bytes||createHash('sha256').update(data).digest('hex')!==r.sha256)throw Error('Driver integrity mismatch: '+r.file);
  if(data[0]!==0x50||data[1]!==0x4b)throw Error('Driver is not a ZIP archive: '+r.file);
 }
 fs.cpSync(path.join(root,'downloads/drivers'),path.join(out,'downloads/drivers'),{recursive:true});
 fs.copyFileSync(path.join(root,'drivers-catalog.json'),path.join(out,'downloads/drivers/catalog.json'));
}
export function driversPage(intro){
 const c=driverCatalog;
 return `<div class="wrap driver-page">${intro('CONNECT / USB DRIVERS','常用驱动，直接下载。','按 USB 芯片选对驱动，再开始连接。CH340、CH343 / CH9102、PL2303 已存放在 CK 服务器，点击即可下载。')}
 <div class="driver-quick"><span>WINDOWS · 整理于 ${e(c.checked)}</span><a href="#drivers">选芯片下载 ↓</a><a href="#identify">不知道选哪个？</a><a href="/drivers/install/">图文安装教程 →</a></div>
 <div class="driver-guide-banner"><div><h2>第一次安装？跟着图片一步步做。</h2><p>ZIP 下载好还没装完：先解压，再按芯片安装，最后在 CK 里选择串口。7 张操作图，点击可以放大。</p></div><a class="button orange" href="/drivers/install/">打开图文教程 →</a></div>
 <div class="driver-bundle"><div><p class="kicker">CK SERVER / DIRECT DOWNLOAD</p><h2>常用驱动合集</h2><p>包含下方 3 个原厂 ZIP 和中文说明，共 ${size(c.bundle.bytes)}。先解压合集，再解压其中需要的那个驱动 ZIP，最后运行安装程序。</p><p class="driver-note">不含 CP210x、FTDI；两项另列原厂入口。无需安装全部驱动。<a class="text-link" href="/drivers/install/#extract">看图学解压 →</a></p></div>${download(c.bundle,'下载合集 ZIP')}</div>
 <div class="article-layout"><nav class="toc" aria-label="驱动页目录"><a href="#drivers">CK 服务器下载</a><a href="#other">其他常用芯片</a><a href="#identify">辨认 USB 芯片</a><a href="#connection">安装与连接</a><a href="#native">原生 USB</a></nav><div class="article">
 <section id="drivers"><h2>选芯片，直接下载</h2><p>文件来自原厂，ZIP 内容未修改。下列版本已核对安装器或驱动目录签名，并生成 SHA-256；这不等于已在所有板卡上实测。</p>
 <div class="driver-list">${c.packages.map(r=>`<article class="driver-card" id="${e(r.id)}"><div class="driver-card-top"><div><p class="driver-vendor">${e(r.vendor)} <span>CK 直下</span></p><h3>${e(r.title)}</h3></div><div class="driver-card-actions">${download(r,'下载 ZIP')}<a class="text-link" href="/drivers/install/#${e(r.id)}">图文安装教程 →</a></div></div><p>${e(r.hint)}</p><div class="driver-specs"><span>版本 ${e(r.version)}</span><span>${size(r.bytes)}</span><span>${e(r.system)}</span></div><p class="driver-install"><strong>安装：</strong>${e(r.install)}</p><details class="driver-details"><summary>支持型号、来源与校验</summary><p><strong>芯片范围：</strong>${e(r.chips)}</p><p>${e(r.notes)}</p><p><strong>硬件 ID 示例：</strong>${r.ids.map(e).join(' / ')}。ID 可能被厂商定制，需结合芯片标识。</p><p>原厂发布：${e(r.date)} · ${e(r.signature)}。</p><p><a class="text-link" href="${e(r.sourcePage)}" target="_blank" rel="noopener noreferrer">原厂版本说明 ↗</a></p><p class="checksum">SHA-256<br><code>${r.sha256}</code></p></details></article>`).join('')}</div>
 <p class="driver-files"><a class="text-link" href="/downloads/drivers/SHA256SUMS.txt" download>下载校验清单 ↓</a><a class="text-link" href="/downloads/drivers/README.txt" download>下载中文说明 ↓</a></p>
 </section>
 <section id="other"><h2>其他常用芯片</h2><p>这两项直接下载原厂 ZIP，无需先进入厂商页面。已核对下列版本及签名；由于原厂许可范围，文件由原厂服务器提供。</p>${c.external.map(r=>`<article class="driver-card driver-external" id="${e(r.id)}"><div class="driver-card-top"><div><p class="driver-vendor">${e(r.vendor)} <span>原厂下载</span></p><h3>${e(r.title)}</h3></div><div class="driver-card-actions"><a class="button outline compact" href="${e(r.url)}" target="_blank" rel="noopener noreferrer">${e(r.label)} ↗</a><a class="text-link" href="/drivers/install/#${e(r.id)}">图文安装教程 →</a></div></div><p>${e(r.reason)}</p><p class="driver-note">${r.version?'版本 '+e(r.version)+' · ':''}${e(r.system)}</p><p class="driver-install">${e(r.install)}</p><details class="driver-details"><summary>文件信息与校验</summary><p>核对日期：${e(r.checked)} · 文件大小：${size(r.bytes)}。原厂可能后续更新同名文件，下列校验值对应此处标明的版本。</p><p><a class="text-link" href="${e(r.sourcePage)}" target="_blank" rel="noopener noreferrer">原厂适用范围与说明 ↗</a></p><p class="checksum">SHA-256<br><code>${r.sha256}</code></p></details></article>`).join('')}</section>
 <section id="identify"><h2>不知道选哪个？先看 USB 芯片</h2><ol><li>看开发板 USB 接口附近的小芯片丝印，例如 CH340、CH9102、CP2102 或 FT232。</li><li>打开 Windows 设备管理器，插拔开发板，找到新出现的端口或未知设备。</li><li>右键设备 → 属性 → 详细信息 → 硬件 ID，结合芯片丝印、板卡厂商说明和上方驱动信息确认。</li></ol><div class="callout">Uno、Nano、Mega、ESP32 是板卡名称，不能单凭它们判断驱动。同一种板卡可能使用不同 USB 芯片；原生 USB 接口也可能不需要另装串口驱动。</div></section>
 <section id="connection"><h2>安装后，让连接真正可用</h2><p><a class="button orange compact" href="/drivers/install/">不会解压或安装？打开图文教程 →</a></p><ol><li>解压整个 ZIP，再按该项说明安装。不要在压缩包预览中直接运行，也不要只复制一个 EXE。</li><li>重新插拔开发板，在设备管理器中确认端口，再回到 CK 选择对应端口。</li><li>仍然看不到端口时，换一根支持数据传输的 USB 线，直连电脑 USB 口，排除充电线和扩展坞问题。</li></ol><p>已有正常串口时通常不用重复安装。上传失败还应检查端口占用、板卡选择与下载模式。</p><div class="callout">驱动由对应厂商维护，按随包许可和安装说明使用。Windows 安装设备驱动可能要求系统授权；无需关闭驱动签名验证。CK 本身以普通用户权限运行。</div></section>
 <section id="native"><h2>原生 USB：先确认接口模式</h2><p>部分 ESP32-S3 / C3 等板卡直接使用芯片原生 USB，也可能同时带独立 USB 转串口芯片。原生接口与串口芯片接口不能套用同一驱动。</p><p>Windows 已正确识别 CDC 串口时，先使用系统驱动。按板卡说明确认 USB 接口、CDC 和上传模式；JTAG、DFU 等用途需遵循对应板卡文档，不要用无关串口驱动强行替换。</p></section>
 </div></div></div>`;
}
