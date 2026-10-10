/**
 * jsonc.mjs —— JSONC（带注释的 JSON）解析。
 *
 * dsh-pet 的 assets/config.jsonc 是 JSONC：文件里既有行首注释，也有大量**行内**注释
 * （实测 160+ 行）。所以只剥行首 `//` 是**不够的** ——
 * 那种偷懒写法会连"未改动的原生文件"都判不过，看着像产物坏了，其实只是解析器自己的误报。
 * 这里用状态机：引号内的 `//`、URL、转义字符都不会被误伤。
 *
 * 抽成独立模块是为了三处共用同一份实现：
 *   lib/host.mjs（运行时读配置）、tools/check-patch.mjs（补丁体检）、tools/test-festivals.mjs（断言）
 * —— 抄三遍必然有一处忘了改。
 */

/** 剥掉注释与尾随逗号，返回"看起来像 JSON"的文本。要报错定位时用它。 */
export function stripJsonc(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // JSONC 允许尾随逗号，JSON 不允许
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 解析 JSONC 文本 */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
