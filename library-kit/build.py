"""Build the three CK authoring references; standard Python 3, no downloads."""
from pathlib import Path
import argparse
import json
import re
import shutil
import zipfile

HERE = Path(__file__).resolve().parent
BOARD = "arduino:avr:uno"
VERSION = "1.0.0"
ARCH = ["avr", "esp32"]


def configuration(driver, fn, arg, lo, hi, code, msg, other=""):
    v = "({{value:" + arg + "}})"
    return (f'static_assert({v} >= {lo} && {v} <= {hi} && (unsigned long){v} == {v}, "{code}: {msg}");\n'
            f"{driver}::{fn}({other}{v});\n")


def arg(name, default, desc):
    return {"name": name, "kind": "value", "description": desc, "check": "Number",
            "required": True, "default": default}


def op(key, label, detail, code, args=(), result=None):
    return dict(key=key, label=label, detail=detail, code=code, args=args, result=result)


BUTTON = "CKButtonLatch"
CLOCK = "CKBeatClock"
MEAN = "CKSampleMean"
SPECS = [
    dict(id="ck_button_latch", driver=BUTTON, name="按钮消抖", color="#247869",
         intro="用内部上拉读取一个常开按钮，分别判断稳定按下状态和按下瞬间。",
         note="按钮一端接所选数字引脚，另一端接 GND。本库管理一个按钮。请在 loop 中反复更新，长时间阻塞会漏掉短按。",
         example="Uno 的 D2 与 GND 之间接按钮。稳定按下后，每次按下只打印一次 1；上电时已按住不制造按下事件。",
         bad=["MS", 0, "CK_BUTTON_DEBOUNCE", "消抖时间须为 1 至 1000 毫秒的整型常量。", 25],
         ops=[op("begin", "初始化按钮 引脚 %1 消抖 %2 毫秒", "启用内部上拉，记录当前电平；低电平为按下。",
                 configuration(BUTTON, "begin", "MS", 1, 1000, "CK_BUTTON_DEBOUNCE", "消抖时间应为整数 1..1000 ms", "{{value:PIN}}, "),
                 [arg("PIN", 2, "板上支持内部上拉的数字引脚"), arg("MS", 25, "消抖毫秒数；配置为整型常量")]),
              op("update", "更新按钮状态", "采样一次。电平持续稳定到设定时间后更新状态；每次更新清除上一轮边沿。", "CKButtonLatch::update();\n"),
              op("edge", "按钮刚刚按下", "本轮更新出现按下边沿才为真；读取不消耗边沿。", "CKButtonLatch::justPressed()", result="Boolean"),
              op("down", "按钮持续按下", "返回消抖后的按住状态；未初始化为假。", "CKButtonLatch::pressed()", result="Boolean")]),
    dict(id="ck_beat_clock", driver=CLOCK, name="非阻塞定时器", color="#3566A3",
         intro="用 millis() 做周期触发，等待期间 loop 可以继续做其他事。",
         note="全库共享一个定时器；每轮只判断一次，到期判断会消费本次事件。错过的多个周期合并为一次，保持原节拍。请至少每个 millis() 回绕周期轮询一次。",
         example="启动 250 ms 周期，每次到期打印一次 250。停止后到期判断一直为假，再次启动会重新计时。",
         bad=["MS", 0, "CK_CLOCK_PERIOD", "周期须为 1 至 3600000 毫秒的整型常量。", 250],
         ops=[op("start", "启动周期定时器 每 %1 毫秒", "记录当前时间，重设一个定时器的周期和起点。",
                 configuration(CLOCK, "start", "MS", 1, 3600000, "CK_CLOCK_PERIOD", "周期应为整数 1..3600000 ms"),
                 [arg("MS", 250, "周期毫秒数；配置为整型常量")]),
              op("due", "定时器到期一次", "到期才返回真并推进节拍；同一时刻再次读取返回假。", "CKBeatClock::poll()", result="Boolean"),
              op("stop", "停止周期定时器", "禁用定时器，直至再次启动。", "CKBeatClock::stop();\n")]),
    dict(id="ck_sample_mean", driver=MEAN, name="滑动平均滤波", color="#80538A",
         intro="保存最近 1 至 16 个有效样本，平滑读数并保留小数。",
         note="全库共享一个窗口；默认长度为 4。清空后均值和计数为 0，未填满时按实际样本数求平均；忽略非有限样本。",
         example="窗口设为 4，依次加入 10 和 15，串口输出 12.50。调整窗口会清空原样本。",
         bad=["SIZE", 17, "CK_MEAN_WINDOW", "窗口须为 1 至 16 的整型常量。", 4],
         ops=[op("reset", "清空并设置平均窗口 %1 个样本", "设置窗口长度，同时丢弃全部旧样本。",
                 configuration(MEAN, "reset", "SIZE", 1, 16, "CK_MEAN_WINDOW", "窗口应为整数 1..16"),
                 [arg("SIZE", 4, "样本数；配置为整型常量")]),
              op("push", "加入样本 %1", "接受数值表达式，填满后覆盖最旧样本。", "CKSampleMean::push({{value:SAMPLE}});\n",
                 [arg("SAMPLE", 10, "需要平滑的数值，可以接传感器或变量")]),
              op("mean", "读取滑动平均", "返回当前样本的浮点平均值；不会改变窗口。", "CKSampleMean::mean()", result="Number"),
              op("count", "当前有效样本数", "返回用于计算均值的实际样本个数。", "CKSampleMean::count()", result="Number")])]


def dump(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def zip_tree(src, dest):
    """An importer reads library.json at ZIP root. Keep names, including nested sources."""
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                entry = zipfile.ZipInfo(p.relative_to(src).as_posix(), (2026, 11, 23, 0, 0, 0))
                z.writestr(entry, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


def num(n):
    return {"shadow": {"type": "math_number", "fields": {"NUM": n}}}


def nested(b):
    return {"block": b}


def chain(*items):
    for before, after in zip(items, items[1:]):
        before["next"] = nested(after)
    return items[0]


def project(s, bad):
    lib = s["id"]

    def block(key, instance=None, **inputs):
        return {"type": lib+"_"+key, "id": lib+"-"+(instance or key), "inputs": inputs}

    def output(value):
        return {"type": "serial_print", "fields": {"NEWLINE": "TRUE"}, "inputs": {"MSG": value}}

    def condition(test, action):
        return {"type": "controls_if", "inputs": {"IF0": nested(test), "DO0": nested(action)}}

    setup = {"type": "serial_setup", "inputs": {"BAUD": num(9600)}}
    value = s["bad"][1 if bad else 4]
    start = block(s["ops"][0]["key"], "config", **{s["bad"][0]: num(value)})
    loop = None
    if s["driver"] == BUTTON:
        start["inputs"]["PIN"] = num(2)
        chain(setup, start)
        loop = chain(block("update"), condition(block("edge"), output(nested(block("down")))))
    elif s["driver"] == CLOCK:
        chain(setup, block("stop"), start)
        loop = condition(block("due"), output(num(250)))
    else:
        chain(setup, start, block("push", "first", SAMPLE=num(10)), block("push", "second", SAMPLE=num(15)),
              output(nested(block("mean"))), output(nested(block("count"))))
    hats = [{"type": "controls_setup_custom", "id": lib+"-setup", "x": 36, "y": 35, "inputs": {"DO": nested(setup)}},
            {"type": "controls_loop_custom", "id": lib+"-loop", "x": 450, "y": 35,
             "inputs": {"DO": nested(loop)} if loop else {}}]
    return {"format": "ck-project", "schema_version": 1, "migration_version": 1,
            "name": s["name"] + (" · 故意报错" if bad else " · 演示"),
            "board": BOARD, "board_package_id": BOARD, "options": "{}",
            "xml": json.dumps({"blocks": {"languageVersion": 0, "blocks": hats}}, ensure_ascii=False)}


def build(s, root, license_path):
    lib, name, driver = s["id"], s["name"], s["driver"]
    p = root/"packages"/lib
    d = p/"libraries"/driver
    shutil.copytree(HERE/"drivers"/driver, d)
    for folder in [p, d]:
        shutil.copyfile(license_path, folder/"LICENSE.txt")
        write(folder/"NOTICE.txt", f"{name} / {driver}\nCopyright 2026 CKYAN. CK LAB.\n")
    write(d/"library.properties",
          f"name={driver}\nversion={VERSION}\nauthor=CKYAN\nmaintainer=CKYAN\nsentence={s['intro']}\n"
          f"paragraph={s['note']}\ncategory=Other\nurl=https://github.com/ovoVHV/CK\narchitectures=avr,esp32\nincludes={driver}.h\n")
    dump(p/"library.json", dict(id=lib, name=name, description=s["intro"], author="CKYAN", version=VERSION,
                               architectures=ARCH, license="Apache-2.0", includes=[driver+".h"]))
    entries = dict(blocks="blocks/blocks.json", generator="blocks/ck-generator.json", toolbox="blocks/toolbox.json")
    blocks, rules, contracts, items = [], [], [], []
    for idx, b in enumerate(s["ops"]):
        typ, detail, args = lib+"_"+b["key"], b["detail"], b["args"]
        result = b["result"]
        shape = "expression" if result else "statement"
        inc = f"#include <{driver}.h>"
        blocks.append(dict(type=typ, message0=b["label"],
                           **({"args0": [dict(type="input_value", name=a["name"], check="Number") for a in args]} if args else {}),
                           inputsInline=True, colour=s["color"], tooltip=detail, helpUrl="",
                           **({"output": result} if result else {"previousStatement": None, "nextStatement": None})))
        rules.append(dict(type=typ, kind=shape, includes={driver: inc}, template=b["code"]))
        items.append(dict(kind="block", type=typ, **({"inputs": {a["name"]: num(a["default"]) for a in args}} if args else {})))
        pin = any(a["name"] == "PIN" for a in args)
        hw = dict(resources=[], claims=dict(version=1, coverage="full", templates=[]), notes=[])
        if driver != MEAN:
            hw["claims"]["coverage"] = "partial"
            hw["notes"].append("使用 Core 的 millis() 时基，不独占硬件定时器。")
        if driver == BUTTON and not pin:
            hw["notes"].append("按钮引脚由初始化积木声明。")
        if pin:
            src = dict(kind="input", name="PIN")
            hw["resources"] = [dict(kind="gpio", id="button", source=src, access="read", sharing="exclusive",
                                    capabilities=["digital-input"], description="内部上拉输入；按钮接地")]
            hw["claims"]["templates"] = [dict(id="button", resource={**src, "valueType":"id"}, role="digital-input", exclusive=True)]
        error = dict(code=s["bad"][2], severity="error", message=s["bad"][3],
                     cause="初始化配置超出范围，或不是编译期整型常量。", recovery=f"把该配置改为 {s['bad'][4]} 后重新编译。")
        contracts.append(dict(type=typ, display_name=b["label"], description=detail, category=name, kind="value" if result else "statement",
                              keywords=[name, driver], semantics=dict(purpose=detail, behavior=detail, concepts=[name], side_effects=[detail]),
                              fields=[], inputs=list(args), output=dict(connection="value" if result else "none", types=[result] if result else []),
                              dependencies=[dict(kind="arduino-library", id=driver, version=VERSION, headers=[driver+".h"],
                                                 reason=f"已内置于 libraries/{driver}/。", license="Apache-2.0")],
                              hardware=hw, generation=dict(language="arduino-cpp", shape=shape, deterministic=True, emissions=[
                                  dict(section="include",description="内置驱动",template=inc),dict(section=shape,description=detail,template=b["code"])]),
                              constraints=[dict(id="instance",severity="info",description=s["note"],message=s["note"])],
                              examples=[dict(id="demo", title="随包示例", description=s["intro"],expected_behavior=s["example"],
                                             project="examples/demo.ck", boards=[BOARD])], errors=[error] if idx==0 else []))
    dump(p/entries["blocks"], blocks)
    dump(p/entries["generator"], dict(schema="ck-generator", version=1, rules=rules))
    dump(p/entries["toolbox"], dict(kind="category", name=name, colour=s["color"], contents=items))
    dump(p/"ck-blocks.json",dict(schema_version=2,id=lib,display_name=name,description=s["intro"],
                                  license=dict(spdx_id="Apache-2.0",file="LICENSE.txt"),compatibility=dict(architectures=ARCH),
                                  entrypoints=entries,blocks=contracts))
    dump(p/"examples/demo.ck", project(s, False))
    dump(p/"examples/invalid.ck", project(s, True))
    dump(p/"examples/expected.json",dict(board=BOARD, positive="demo.ck",negative="invalid.ck",blockId=lib+"-config",
                                          errorCode=s["bad"][2],input=s["bad"][0],invalid=s["bad"][1],repair=s["bad"][4]))
    write(p/"README.md", f"# {name}\n\n{s['intro']}\n\n{s['note']}\n\n## 试用\n\n"
          f"在 CK 库管理器导入此 ZIP，打开 `examples/demo.ck`。{s['example']} 串口为 9600。\n\n"
          f"要练习定位错误，打开 `examples/invalid.ck` 并编译，初始化积木应出现红色警告。"
          f"`{s['bad'][2]}`：{s['bad'][3]} 将 {s['bad'][1]} 改为 {s['bad'][4]} 再编译。\n\n"
          f"库内自带 `libraries/{driver}/` 完整源码，只需相应 Arduino Core。作者 CKYAN，Apache-2.0。"
          "目标架构 AVR、ESP32；示例板卡为 Uno。编译不证明接线或实物行为。\n")
    zip_tree(p, root/f"{lib}-{VERSION}.zip")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("output", type=Path, help="new output directory; existing files are never overwritten")
    opts = cli.parse_args()
    out = opts.output.resolve()
    ids = [s["id"] for s in SPECS]
    assert len(set(ids)) == len(ids) and all(re.fullmatch(r"[a-z][a-z0-9_]+", i) for i in ids)
    license_file = HERE/"LICENSE" if (HERE/"LICENSE").is_file() else HERE.parent/"LICENSE"
    out.mkdir(parents=True, exist_ok=False)
    for spec in SPECS:
        build(spec, out, license_file)
    print(f"Built {len(SPECS)} libraries in {out}")
