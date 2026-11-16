"""Generate original, labeled instructional diagrams; these are not screenshots."""
from pathlib import Path
from html import escape as esc

out=Path(__file__).parent/'driver-guide-media'
out.mkdir(exist_ok=True)
orange='#bc470b'
def rect(x,y,w,h,fill='#fff',stroke='#dadbd3',radius=10):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'
def text(x,y,value,size=23,color='#292c29',weight=400):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}">{esc(value)}</text>'
def badge(x,y,n):
    return f'<circle cx="{x}" cy="{y}" r="17" fill="{orange}"/>'+text(x,y+7,str(n),21,'#fff',700).replace(f'x="{x}"',f'x="{x}" text-anchor="middle"')
def label(x,y,n,value):
    return badge(x,y-7,n)+text(x+30,y,value,22,orange,700)
def folder(x,y):
    return f'<path d="M{x} {y+7}v29h43V{y+6}H{x+18}l-5-6H{x}Z" fill="#f1c05a" stroke="#b79335"/>'
def file(x,y,kind):
    return rect(x,y,40,49,'#fff','#aeb8c0',3)+text(x+4,y+32,kind,13,'#6b747e',700)
def window(title):
    return rect(24,70,672,300)+rect(24,70,672,43,'#eeefea')+text(45,99,title,20,'#63685e')+text(645,99,'×',24)
def svg(name,title,body):
    s=f'<svg xmlns="http://www.w3.org/2000/svg" width="720" height="410" viewBox="0 0 720 410" role="img" aria-labelledby="title"><title id="title">{esc(title)} · 操作示意</title><rect width="720" height="410" fill="#f4f4ed"/><g font-family="Segoe UI,Microsoft YaHei,Arial,sans-serif">{text(25,40,title,25,"#272b24",700)}{text(573,39,"操作示意",18,"#7a7e73")}{body}{text(25,395,"界面会随 Windows / 浏览器版本略有不同",16,"#747a6e")}</g></svg>'
    (out/name).write_text(s,encoding='utf-8')

svg('01-download.svg','找到刚下载的 ZIP 文件',
    window('浏览器 · 下载记录')+label(59,147,1,'按 Ctrl + J，打开下载记录')+
    rect(48,172,624,162,'#fafbf7')+file(69,191,'ZIP')+
    text(126,215,'CH341SER-4.0.ZIP',24,weight=600)+text(126,249,'下载完成',19,'#637462')+
    rect(119,267,246,49,'#fff0e5',orange)+text(137,300,'在文件夹中显示',24,orange,600)+badge(401,292,2))
svg('02-extract.svg','先解压，再打开普通文件夹',
    window('文件资源管理器 · 下载')+file(50,144,'ZIP')+
    text(105,176,'CH341SER-4.0.ZIP',22,weight=600)+badge(381,167,1)+
    rect(106,195,268,109,'#fff','#b8bbb1')+text(124,229,'右键菜单',19,'#72796b')+
    rect(119,244,240,44,'#fff0e5',orange,5)+text(131,274,'全部解压缩…',24,orange,600)+
    text(400,236,'→',35,orange)+folder(452,189)+text(449,262,'普通文件夹',24,weight=600)+
    text(449,295,'双击它，继续安装',19)+
    label(67,343,2,'点“提取”，等待解压完成'))
svg('03-setup.svg','找到 SETUP.EXE，双击运行',
    window('解压后的文件夹 · CH341SER')+
    folder(55,136)+text(114,166,'DRVSETUP64',22)+
    rect(45,196,415,65,'#fff0e5',orange)+file(59,203,'EXE')+
    text(116,237,'SETUP.EXE',28,orange,700)+badge(495,230,1)+
    text(56,301,'双击 → 按安装器提示点击 Install / 安装',24)+
    text(56,338,'PL2303 请找以 PL23XX 开头的安装程序',19,'#686e61'))
svg('04-cp210x.svg','CP210x：右键 INF 文件安装',
    window('解压后的文件夹 · CP210x')+
    file(50,136,'CAT')+text(109,168,'silabser.cat',23,'#72796b')+
    rect(45,202,294,61,'#fff0e5',orange)+file(54,207,'INF')+
    text(109,242,'silabser.inf',27,orange,700)+badge(370,231,1)+
    rect(417,149,249,157,'#fff','#b8bbb1')+text(436,183,'右键菜单',19,'#72796b')+
    rect(430,200,222,45,'#fff0e5',orange,5)+text(447,231,'安装',26,orange,700)+
    text(436,281,'打开 / 属性…',19,'#72796b')+
    text(53,344,'Windows 11 没看到“安装”？先点“显示更多选项”',21))
svg('05-device.svg','FTDI：找到插入后出现的设备',
    window('设备管理器')+
    text(51,145,'⌄  其他设备',24,weight=600)+
    rect(74,163,299,53,'#fff0e5',orange)+text(93,198,'USB Serial Converter',22,orange,600)+
    text(92,249,'也可能显示为未知设备',20,'#72796b')+
    rect(409,143,257,148,'#fff','#b8bbb1')+text(427,177,'右键对应设备',21)+
    rect(421,192,233,46,'#fff0e5',orange,5)+text(432,223,'更新驱动程序',23,orange,700)+
    text(428,270,'属性…',20,'#72796b')+
    text(52,334,'开始按钮右键 → 设备管理器',24)+
    text(52,361,'先插拔一次，确认哪一项对应你的开发板',19,'#72796b'))
svg('06-browse.svg','选择解压目录，并包括子文件夹',
    window('浏览我的电脑以查找驱动程序')+
    label(61,145,1,'浏览… → 选择刚解压出的文件夹')+
    rect(52,167,481,45,'#fafbf7')+text(65,197,'下载 / CDM-v2.12.36.20…',21)+
    rect(551,167,116,45,'#fff0e5',orange,4)+text(569,197,'浏览…',21,orange,700)+
    rect(54,242,26,26,orange,orange,3)+text(58,262,'✓',22,'#fff',700)+text(94,263,'包括子文件夹',24,weight=600)+badge(330,255,2)+
    rect(510,299,156,47,'#fff0e5',orange,4)+text(544,330,'下一步',24,orange,700)+badge(470,322,3)+
    text(54,331,'选择文件夹，不选择 ZIP',22))
svg('07-port.svg','看到 COM 端口后，在 CK 选同一个',
    rect(25,72,670,151)+text(47,105,'设备管理器',20,'#72796b')+
    text(48,144,'⌄  端口（COM 和 LPT）',24,weight=600)+
    rect(72,160,519,45,'#ecf5e9','#a2bf98',5)+text(89,191,'USB-SERIAL CH340 (COM5)',25,'#326c36',700)+
    rect(25,242,670,127)+text(47,277,'CK · 编程页',20,'#72796b')+
    text(47,321,'选择串口',25,weight=600)+text(184,323,'→',27,orange)+
    rect(236,291,200,46,'#fff0e5',orange,5)+text(264,323,'COM5',27,orange,700)+
    text(465,321,'再点击上传',23)+
    text(47,354,'COM5 仅为示例；以你电脑实际显示的编号为准',18,'#72796b'))
print(f'Generated {len(list(out.glob("*.svg")))} labeled SVG illustrations')
