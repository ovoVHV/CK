import {driverCatalog} from './drivers.mjs';
const e=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const figures=[
 ['01-download','找到下载的压缩包','在浏览器按 Ctrl + J，找到下载记录，点击“在文件夹中显示”。'],
 ['02-extract','把 ZIP 解压成普通文件夹','右键 ZIP，选择“全部解压缩”，再点“提取”；接下来打开解压出的普通文件夹。'],
 ['03-setup','双击安装程序','CH340 示例：解压后进入 CH341SER 文件夹，双击 SETUP.EXE。'],
 ['04-cp210x','CP210x 的 INF 安装方法','右键 silabser.inf，点击“安装”。Windows 11 可能需要先点“显示更多选项”。'],
 ['05-device','在设备管理器里找到开发板','插拔开发板确认新增的设备，再右键该项，选择“更新驱动程序”。设备名称可能与示意不同。'],
 ['06-browse','让 Windows 到解压目录找驱动','选择解压后的目录，勾选“包括子文件夹”，点击“下一步”。'],
 ['07-port','把设备管理器里的 COM 编号选到 CK','确认串口无黄色警告，再在 CK 的“选择串口”中选相同编号。COM5 仅是示例。']
];
const figure=i=>{
 const [file,title,alt]=figures[i];
 return `<figure class="product-visual install-figure"><a class="visual-open" href="/assets/driver-guide/${file}.svg" data-visual-title="${e(title)}"><img src="/assets/driver-guide/${file}.svg" alt="${e(alt)}" width="720" height="410" loading="lazy"><span class="visual-zoom">点击放大</span></a><figcaption><span class="visual-source">操作示意</span>${e(alt)} 菜单名称可能随系统版本略有不同。</figcaption></figure>`;
};
const packageLink=id=>{
 const p=[...driverCatalog.packages,...driverCatalog.external].find(p=>p.id===id);
 return `<a class="text-link" href="${e(p.url)}" ${p.sourceUrl?'download':'target="_blank" rel="noopener noreferrer"'}>下载${p.sourceUrl?' ':'原厂 '}ZIP ↓</a>`;
};
export function driverGuidePage(intro){
 return `<div class="wrap install-page">
 <p class="install-back"><a href="/drivers/">← 返回驱动下载</a></p>
 ${intro('CONNECT / STEP BY STEP','驱动下好了，接下来怎么装？','从找到 ZIP，到 CK 里出现串口，跟着图片一步一步做。适用于驱动页列出的 Windows 10 / 11 驱动包。')}
 <div class="install-overview" aria-label="安装流程"><span><b>1</b>找到下载</span><i>→</i><span><b>2</b>解压文件</span><i>→</i><span><b>3</b>按芯片安装</span><i>→</i><span><b>4</b>选择串口</span></div>
 <div class="install-start"><strong>ZIP 是“打包好的文件”，下载完成还不等于安装完成。</strong><p>先解压出普通文件夹，再按芯片选一种安装方法。如果开发板已经正常显示串口，可以直接看<a href="#check">第 4 步</a>，通常不用重装。</p></div>
 <div class="article-layout install-layout"><nav class="toc" aria-label="安装教程目录"><a href="#download">1. 找到下载</a><a href="#extract">2. 解压 ZIP</a><a href="#choose">3. 选择安装方法</a><a href="#setup">　CH340 / CH9102 / PL2303</a><a href="#cp210x">　CP210x</a><a href="#ftdi">　FTDI</a><a href="#check">4. 在 CK 里选串口</a><a href="#help">卡住了？看这里</a></nav><div class="article">
 <section id="download"><h2><span class="install-number">1</span>找到刚下载的文件</h2><ol><li>先在<a href="/drivers/" class="text-link">驱动下载页</a>下载与你的 USB 芯片对应的 ZIP。<strong>只选需要的一个，不用全部安装。</strong></li><li>回到浏览器，按键盘 <kbd>Ctrl</kbd> + <kbd>J</kbd>，打开下载记录。</li><li>找到刚下载的 ZIP，点击<strong>“在文件夹中显示”</strong>，或旁边的文件夹图标。</li></ol>${figure(0)}<p class="install-tip">不确定芯片？看开发板 USB 接口旁的小芯片文字，或查板卡厂商说明。Uno / Nano / ESP32 是板卡名称，并不能直接决定装哪个驱动。<a href="/drivers/#identify" class="text-link">查看辨认方法 →</a></p></section>
 <section id="extract"><h2><span class="install-number">2</span>把 ZIP 解压出来</h2><ol><li>用鼠标<strong>右键点击 ZIP 文件</strong>，选择“全部解压缩…”或“解压缩全部…”。</li><li>在弹出的窗口中点击<strong>“提取”</strong>，等待完成。也可以用已安装的解压软件“解压到同名文件夹”。</li><li>打开解压得到的<strong>普通文件夹</strong>。下一步都在这个文件夹中操作，不在压缩包预览中操作。</li></ol>${figure(1)}
 <aside class="install-nested"><h3>下载的是“常用驱动合集”？要解压两层</h3><p>合集里装的是 3 个原厂 ZIP。先解压合集，再把你需要的那个 ZIP 解压一次：</p><div class="install-nested-flow"><span>CK 驱动合集 .zip</span><b>↓ 解压</b><span>例如 CH341SER-4.0.ZIP</span><b>↓ 再解压</b><span>普通文件夹 → CH341SER → SETUP.EXE</span></div><p>CP210x 和 FTDI 需要在下载页单独下载，不在合集里。</p></aside>
 <details class="install-faq"><summary>文件名后面没有 .zip、.exe 或 .inf？</summary><p>Windows 可能隐藏了扩展名。在文件资源管理器中打开“查看 → 显示 → 文件扩展名”（Windows 11），或“查看 → 文件扩展名”（Windows 10）。只是显示名称，不需要重命名文件。</p></details></section>
 <section id="choose"><h2><span class="install-number">3</span>按你的芯片，只选一种方法</h2><p>先完成上面的解压。然后按芯片名称点对应方法：</p><div class="install-choices"><a href="#setup"><strong>CH340 / CH341<br>CH343 / CH9102 · PL2303</strong><span>双击安装程序 →</span></a><a href="#cp210x"><strong>CP210x<br>CP2102 / CP2102N</strong><span>右键 INF 安装 →</span></a><a href="#ftdi"><strong>FTDI<br>FT232 / FT231X 等</strong><span>设备管理器安装 →</span></a></div></section>
 <section id="setup"><p class="install-method">方法 A · CH340 / CH9102 / PL2303</p><h2>有安装程序：双击它</h2><p>打开解压后的文件夹，按下面的位置找到安装程序。<strong>保留同文件夹中的其他文件，不要只把 EXE 拖出去。</strong></p><div class="install-files">
 <article id="ch340"><h3>CH340 / CH341</h3><p>先解压 ZIP，再进入 <code>CH341SER</code> 文件夹，双击 <code>SETUP.EXE</code>。</p>${packageLink('ch340')}</article>
 <article id="ch343"><h3>CH343 / CH9102 等</h3><p>先解压 ZIP，再依次打开 <code>CH343SER → Driver</code>，双击 <code>SETUP.EXE</code>。</p>${packageLink('ch343')}</article>
 <article id="pl2303"><h3>PL2303 / PL2323</h3><p>先解压 ZIP，打开包内同名文件夹，双击以 <code>PL23XX-M_LogoDriver_Setup</code> 开头的 EXE。</p><details><summary>当前包的完整文件名</summary><p><code>PL23XX-M_LogoDriver_Setup_41000_20260716.exe</code></p></details>${packageLink('pl2303')}</article>
 </div>${figure(2)}<p>启动后按原厂安装器提示，点击 <strong>Install / 安装</strong>，或依次点击 <strong>Next / 下一步</strong>，完成后退出安装器。Windows 如果请求设备驱动安装授权，请核对厂商后按提示操作。</p><a class="button outline compact" href="#check">安装完成，去检查串口 →</a></section>
 <section id="cp210x"><p class="install-method">方法 B · CP210x / CP2102 / CP2102N</p><h2>没有 SETUP？找 silabser.inf</h2><p>这个驱动包本来就没有 SETUP.EXE。先解压整个 ZIP，打开解压后的文件夹：</p><ol><li>找到 <code>silabser.inf</code>，<strong>用鼠标右键点击它</strong>。不要选 <code>silabser.cat</code>。</li><li>点击<strong>“安装”</strong>。Windows 11 没有直接显示时，先点<strong>“显示更多选项”</strong>，再点“安装”。</li><li>按系统提示完成。然后插上开发板，去第 4 步检查串口。</li></ol>${figure(3)}<p class="install-tip">仍然没有“安装”，或安装后没有正确识别？可以改用下面的<a href="#device-manager">设备管理器方法</a>，选择你解压出的 <strong>CP210x 文件夹</strong>。</p><div class="install-actions">${packageLink('cp210x')}<a class="button outline compact" href="#check">去检查串口 →</a></div></section>
 <section id="ftdi"><p class="install-method">方法 C · FTDI / FT232 / FT231X 等</p><h2>让设备管理器读取驱动文件夹</h2><p>当前 FTDI ZIP 没有安装 EXE。解压整个包，保留 <code>ftdibus.inf</code>、<code>ftdiport.inf</code> 和子文件夹，然后接上开发板。</p>${packageLink('ftdi')}
 <h3 id="device-manager">先找到设备，再更新驱动</h3><ol><li>鼠标<strong>右键点击 Windows 开始按钮</strong>，打开<strong>“设备管理器”</strong>。</li><li>拔下、再插上开发板，观察哪一项消失又出现。未装好时可能在<strong>“其他设备”</strong>中，也可能带黄色警告；名称以实际设备为准。</li><li>确认是这块开发板后，右键该设备 → <strong>“更新驱动程序”</strong>。</li><li>选择<strong>“浏览我的电脑以查找驱动程序”</strong>。</li></ol>${figure(4)}
 <h3>选中解压目录</h3><ol><li>点击<strong>“浏览…”</strong>，选中刚解压出来的 <strong>FTDI 驱动文件夹</strong>。如果你在用此方法安装 CP210x，就选择 CP210x 文件夹。</li><li>勾选<strong>“包括子文件夹”</strong>，点击<strong>“下一步”</strong>。</li><li>等待 Windows 完成安装。如果提示不匹配，请重新确认芯片和目录，不要强制指定无关驱动。</li></ol>${figure(5)}
 <div class="install-tip"><strong>FTDI 有时需要做两遍。</strong>第一遍后若又出现未识别的 <code>USB Serial Port</code>，对它重复“更新驱动程序 → 浏览目录”，仍选同一个 FTDI 文件夹。</div><p><a class="button outline compact" href="#check">装完了，去检查串口 →</a></p></section>
 <section id="check"><h2><span class="install-number">4</span>看到 COM，再回 CK 选串口</h2><ol><li>安装完成后，重新插拔一次开发板。</li><li>在设备管理器展开<strong>“端口（COM 和 LPT）”</strong>。找到这块板的串口，确认没有黄色警告，记住括号里的编号。</li><li>回到 CK 编程页，点击<strong>“选择串口”</strong>，选相同的 <strong>COM 编号</strong>。例如设备管理器是 COM5，CK 就选 COM5。</li><li>确认 CK 中的板卡选对，再点击上传。</li></ol>${figure(6)}<div class="install-success"><strong>做到这一步，驱动连接就检查清楚了。</strong><p>能看到 COM，说明 Windows 已识别串口；上传还受板卡选择、线材、端口占用和下载模式影响。COM5 只是举例，每台电脑可能不同。</p></div></section>
 <section id="help"><h2>卡在哪一步，就看哪一项</h2>
 <details class="install-faq"><summary>根本没有“端口（COM 和 LPT）”</summary><p>先确认开发板已连接，并换一根能传数据的 USB 线，直接插电脑。只有充电功能的线不会产生串口。然后查看“其他设备”，按芯片选对驱动再安装。</p><p>原生 USB 的板卡还要确认接口和工作模式，不能一律安装 CH340。<a class="text-link" href="/drivers/#native">原生 USB 说明 →</a></p></details>
 <details class="install-faq"><summary>压缩包打不开，或者里面找不到教程说的文件</summary><p>确认下载完成，再重新解压整个 ZIP。下载的是合集时，要继续解压里面对应的驱动 ZIP。CP210x 用 silabser.inf，FTDI 用设备管理器，本来就没有 SETUP.EXE。</p></details>
 <details class="install-faq"><summary>安装成功了，CK 还是看不到串口</summary><p>先看设备管理器是否出现正确端口。若有，重新打开 CK 的串口选择，必要时保存工程后重启 CK；若没有，回到设备管理器查看警告信息。其他串口软件也可能占用设备，先关闭它们再试。</p></details>
 <details class="install-faq"><summary>驱动不匹配，或安装后仍有黄色警告</summary><p>打开设备属性，记录错误代码、硬件 ID 和芯片型号。先核对驱动页的系统与芯片支持范围，尤其是 PL2303 旧芯片。不要为了安装而关闭签名验证，也不要随意替换成其他芯片的驱动。</p></details>
 <details class="install-faq"><summary>为什么安装驱动弹出系统授权？</summary><p>设备驱动安装可能需要 Windows 系统授权，按原厂安装流程处理即可。CK 的日常编程与编译使用普通用户权限。</p></details>
 <p class="install-footnote">本教程核对的是驱动下载页标注的版本，整理于 2026-11-09。图片为 CK 绘制的操作示意，不是真实安装截图；系统菜单、设备名称和端口号以你的电脑为准。安装方法同时参照各原厂压缩包中的说明，驱动文件保持原样。</p><a class="text-link" href="/drivers/">返回下载页，查看对应版本与原厂说明 →</a></section>
 </div></div></div>`;
}
