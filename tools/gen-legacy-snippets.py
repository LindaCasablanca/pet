# 一次性生成器：把当前 plugin 里被 cc-switch 版补丁改过的区域，逐字节截取出来，
# 作为新版补丁的"就地迁移"候选匹配串（lib/legacy-snippets.json）。
# 只在首次移植时跑一次；生成物随包走。
#
# ⚠️ 只能对着「还带着 cc-switch 改造」的产物跑。现在 plugin 已经被本包改成 hermes 版了，
#    直接再跑一次会把 hermes 版的文本当成"上一版"截出来，legacy-snippets.json 就废了。
#    真要重生成，得先把 cc-switch 版的产物放回来。
import json
import os
import pathlib

H = pathlib.Path(os.environ.get("LOCALAPPDATA", ""), "dsh-pet", "plugin", "runtime", "electron-helper")

SPECS = [
    # (id, 文件, 起始锚点, 结束锚点)
    ("parse-balance", "shared-core.js",
     '\t\t\ttoppedUp: typeof d.toppedUp === "string" ? d.toppedUp : void 0,',
     'tierMax: Number(d.tierMax) > 0 ? Number(d.tierMax) : void 0\n\t\t};'),
    ("balance-percent", "shared-core.js",
     'if (v.kind === "deepseek") {',
     '100 - (bal / max) * 100));\n\t}'),
    ("bubble-rows", "shared-core.js",
     '\t\t// [cc-switch 改造:bubble-rows]',
     '\t\treturn rows;'),
    ("menu-labels", "sprite.js",
     '    // [cc-switch 改造:menu-labels]',
     "tools.push({ label: '查看用量与余额', action: 'show-balance' });"),
    ("bubble-wide", "sprite.js",
     "    this.bubble.classList.toggle(\n      'is-whisper',",
     '        && Array.isArray(this.balanceView) && this.balanceView.length >= 3,\n    );'),
    ("open-site", "main.js",
     '  // [cc-switch 改造:open-site]',
     "      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);\n    });\n  });"),
    ("css-wrap", "index.html",
     '        /* [cc-switch 改造:css-wrap]',
     '        overflow-wrap: anywhere;'),
    ("css-width", "index.html",
     '        /* [cc-switch 改造:css-width]',
     '        max-width: calc(var(--pet-size, 462px) * 0.62);'),
    ("css-iswide", "index.html",
     '      /* [cc-switch 改造:css-iswide]',
     '      .pet-bub-row {'),
]

out = {}
for rid, fn, start_anchor, end_anchor in SPECS:
    text = (H / fn).read_text(encoding="utf-8")
    i = text.find(start_anchor)
    if i < 0:
        print(f"!! {rid}: 起始锚点没找到（{fn}）")
        continue
    j = text.find(end_anchor, i)
    if j < 0:
        print(f"!! {rid}: 结束锚点没找到（{fn}）")
        continue
    snippet = text[i:j + len(end_anchor)]
    out[rid] = snippet
    print(f"OK {rid:16s} {fn:16s} {len(snippet):6d} 字节  {snippet.count(chr(10)) + 1} 行")

target = pathlib.Path(__file__).resolve().parent.parent / "lib" / "legacy-snippets.json"
target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n写出:", target, target.stat().st_size, "字节，共", len(out), "条")
