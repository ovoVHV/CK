"""Prepare inspected CK screenshots; crop only, never redraw product UI."""
from pathlib import Path
from PIL import Image
import hashlib,json

repo=Path(__file__).resolve().parents[2]
evidence=repo/'local/ck-lab-visuals-20261109'
out=repo/'website/media';out.mkdir(parents=True,exist_ok=True)
sources=[
 ('compile',Path('C:/CKLocalPerf/alpha19/installed-live-progress.png'),None,'桌面编译进度与实时日志','CK 编译界面显示准备、编译、链接、产物阶段和持续输出的任务日志。','桌面预览版实拍；截图中的计时仅表示拍摄时状态，不是性能成绩。','desktop-capture'),
 ('recovery',evidence/'recovery-source.png',None,'恢复前，先看清积木差异','恢复稿与正式版本左右对比：延时由 500 改为 250 毫秒，并新增一条串口输出。','CK 实际恢复组件 · 示例工程。绿色标记新增积木，黄色标记修改。','component-sample'),
 ('serial',evidence/'serial-source.png',None,'串口数据，变成能观察的曲线','串口曲线展示温度与湿度两个示例系列，以及阈值和触发前后时间窗设置。','CK 实际串口组件 · 合成示例数据，未连接硬件。','component-sample'),
 ('pins',Path('C:/CKLocalPerf/alpha18/ui-evidence/pin-preflight-1793727675441/panel.png'),(270,90,1536,1068),'积木里的引脚，检查里看得见','超声波积木填写 TRIG 5 和 ECHO 6，工程检查列出两个引脚的用途与引用。','桌面预览版截图；按已声明能力检查，未覆盖项会明确提示。','desktop-capture'),
 ('debug',repo/'docs/audits/debug-trace-fix-2026-11-04/paused-block-location.png',(270,90,1536,1152),'停在积木上，继续或单步','积木断点高亮，调试面板提供继续、单步和结束调试操作。','真实桌面 UI + 模拟串口回执；仅演示界面，不代表实体板验证。','simulated-transport'),
 ('trace',repo/'docs/audits/debug-trace-fix-2026-11-04/trace-coverage.png',(270,90,1536,1152),'运行轨迹与覆盖范围','运行轨迹面板列出命中过的积木及已纳入采样的范围。','真实桌面 UI + 模拟串口数据；图中覆盖比例只属于该测试示例。','simulated-transport'),
 ('core',repo/'local/alpha27-evidence/core-manager.png',(242,126,1294,1027),'核心包与版本，在一处管理','Core 管理器列出 Arduino AVR 与 ESP32 核心包，支持选版本、刷新和安装。','Core 管理器实拍；可用版本为拍摄时状态，以软件实时列表为准。','desktop-capture'),
]
editor_evidence=repo/'local/ck-lab-editor-20261109'
sources.extend([
 ('quick-select',editor_evidence/'quick-select-source.png',(260,125,1020,776),'快速选积木与关键词搜索','Ctrl+K 搜索串口积木，列表展示积木预览、固定按钮和键盘操作。','CK 实际组件 · 内置积木示例；搜索与插入可操作。','component-sample'),
 ('quick-insert',editor_evidence/'quick-insert-menu-source.png',(65,165,630,425),'选择积木的插入位置','选中串口打印积木后点加号，可以选择值输入或在后面添加语句。','CK 实际组件 · 选中积木后的 + 和插入位置菜单。','component-sample'),
 ('quick-insert-filter',editor_evidence/'quick-insert-filter-source.png',(260,125,1020,776),'搜索可接入的积木','快速插入列表显示只接入在后面添加的位置，搜索延时积木。','CK 实际组件 · 按连接类型筛选，不表示硬件兼容性验证。','component-sample'),
 ('block-errors',editor_evidence/'block-errors-source.png',(20,125,1260,660),'编译报错积木的红色提示与定位','积木红色轮廓和感叹号，下方错误卡片包含定位积木按钮。','CK 实际组件 · 重现 alpha.31 已通过真实 Uno 编译验证的错误示例；配图页面不执行编译。','component-sample'),
])
rows=[]
for key,source,crop,title,alt,caption,kind in sources:
 im=Image.open(source).convert('RGB')
 if crop: im=im.crop(crop)
 im.save(out/f'{key}.webp','WEBP',lossless=True,method=6)
 small=im.copy();small.thumbnail((768,10000),Image.Resampling.LANCZOS);small.save(out/f'{key}-768.webp','WEBP',quality=92,method=6)
 rows.append(dict(id=key,width=im.width,height=im.height,title=title,alt=alt,caption=caption,kind=kind,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),crop=crop))
(out/'manifest.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'images':len(rows),'webpBytes':sum(p.stat().st_size for p in out.glob('*.webp'))}))
