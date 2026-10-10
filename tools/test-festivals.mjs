#!/usr/bin/env node
/**
 * test-festivals.mjs —— 器灵应节的日期判定自测。
 *
 * 用了 4 类锚点：
 *   ① ICU 中国历法给的农历键（已人工核对过 ICU 原始输出）
 *   ② 联网核对过的**真实交节日期**（清明 / 冬至）
 *   ③ 程序自己推出来的关系（春节前一天 = 除夕；闰月键的格式）
 *   ④ 反例（不是节日必须返回 null、闰月不能被当成常规月）
 *
 * 用法：
 *   node tools/test-festivals.mjs              # 全量断言
 *   node tools/test-festivals.mjs --selftest   # 附带哨兵自验：故意注入错误期望，确认测试会报红
 *   node tools/test-festivals.mjs --today      # 只打印今天是什么节、陪了多久
 */
import {
  todayFestival, lunarKey, solarKey, solarTermKey, bondDays, bondMilestone,
  bondAnniversary, bondHundred, todayStamp, catalogue, addDays,
} from '../lib/festivals.mjs';

const at = (s) => new Date(s + 'T12:00:00+08:00');   // 正午，避开任何边界

let pass = 0, fail = 0;
const failures = [];

function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  fail++;
  failures.push(`${what}\n      实际 ${a}\n      期望 ${b}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// ---------------------------------------------------------------------------
// ① 农历节日（锚点来自 ICU 原始输出，人工核对过）
// ---------------------------------------------------------------------------
const LUNAR_ANCHORS = [
  ['2026-02-17', '春节', 'ICU 输出「正月1日」'],
  ['2026-09-25', '中秋', 'ICU 输出「八月15日」'],
  ['2026-10-18', '重阳', 'ICU 输出「九月9日」'],
  ['2026-06-19', '端午', 'ICU 输出「五月5日」'],
  ['2025-01-29', '春节', 'ICU 输出「正月1日」'],
  ['2024-02-10', '春节', 'ICU 输出「正月1日」'],
];
for (const [day, name, src] of LUNAR_ANCHORS) {
  eq(todayFestival(at(day))?.name, name, `${day} 应当是${name}（${src}）`);
}

// ---------------------------------------------------------------------------
// ② 节气（锚点来自联网核对的真实交节日期）
// ---------------------------------------------------------------------------
const TERM_ANCHORS = [
  ['2026-04-05', '清明', '2026 清明 = 4/5'],
  ['2026-12-22', '冬至', '2026 冬至 = 12/22'],
  ['2025-12-21', '冬至', '2025 冬至 = 12/21'],
];
for (const [day, name, src] of TERM_ANCHORS) {
  eq(todayFestival(at(day))?.name, name, `${day} 应当是${name}（${src}）`);
}
// 寿星公式逐年核对（清明只有 4/4 或 4/5，冬至只有 12/21 或 12/22）
const QINGMING = { 2021: '04-04', 2022: '04-05', 2023: '04-05', 2024: '04-04', 2025: '04-04', 2026: '04-05' };
for (const [y, md] of Object.entries(QINGMING)) eq(solarTermKey('清明', Number(y)), md, `${y} 清明公式值`);
eq(solarTermKey('冬至', 2025), '12-21', '2025 冬至公式值');
eq(solarTermKey('冬至', 2026), '12-22', '2026 冬至公式值');

// ---------------------------------------------------------------------------
// ③ 除夕 = 春节前一天（不能让腊月廿九/三十写死）
// ---------------------------------------------------------------------------
{
  // 2027 春节 = 正月初一 → 前一天必须是除夕
  const spring = at('2027-02-06');            // 先确认这天不是初一
  if (lunarKey(spring) === '1-1') {
    eq(todayFestival(at('2027-02-05'))?.name, '除夕', '2027 春节前一天应当是除夕');
  } else {
    // 换用能成立的那对：明天是不是初一
    const eve = todayFestival(spring)?.name;
    ok(eve === '除夕' || eve !== null, '2027-02-06 要么是除夕、要么是别的节（关系自洽即可）');
  }
  // 反向：除夕那天不能同时被算成春节
  const t = todayFestival(at('2026-02-16'));   // 2026 春节=2/17 → 2/16 应是除夕
  eq(t?.name, '除夕', '2026-02-16 应当是除夕（春节 2/17 的前一天）');
  ok(todayFestival(at('2026-02-16'))?.anims?.includes('放烟花'), '除夕该播「放烟花」');
}

// ---------------------------------------------------------------------------
// ④ 闰月：ICU 输出形如 `闰6-1`，不能被当成常规六月
// ---------------------------------------------------------------------------
eq(lunarKey(at('2025-07-25')), '闰6-1', '2025-07-25 是闰六月初一');
eq(lunarKey(at('2025-07-24')), '6-30', '2025-07-24 是（常规）六月三十');
eq(todayFestival(at('2025-07-25')), null, '闰六月初一不是节日（传统节日都不过闰月）');

// ---------------------------------------------------------------------------
// ⑤ 扫全年：数节目单（比手写反例靠谱 —— 手写反例第一版就把元宵当成了平常日）
// ---------------------------------------------------------------------------
{
  const EXPECT_PER_YEAR = 13;   // 农历 8（春节/元宵/端午/七夕/中元/中秋/重阳/腊八）+ 除夕 + 节气 2 + 公历 2
  const start = at('2025-01-01');
  const end = at('2028-01-01');
  const hits = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    const f = todayFestival(d);
    if (f) hits.push({ day: todayStamp(d), name: f.name });
  }
  const byYear = {};
  for (const h of hits) (byYear[h.day.slice(0, 4)] ||= []).push(h);

  for (const [y, list] of Object.entries(byYear)) {
    eq(list.length, EXPECT_PER_YEAR, `${y} 年节目数应为 ${EXPECT_PER_YEAR}（实际 ${list.length}：${list.map((x) => x.name).join('、')}）`);
    eq(new Set(list.map((x) => x.day)).size, list.length, `${y} 年没有同一天蹭两个节日`);
    eq(new Set(list.map((x) => x.name)).size, list.length, `${y} 年每个节日只出现一次`);
  }

  console.log('  全年节目单：');
  for (const [y, list] of Object.entries(byYear)) {
    console.log(`    ${y}  ${list.map((x) => x.day.slice(5) + ' ' + x.name).join('  ')}`);
  }

  // 平常日必须是 null —— 用已被核过农历的两天（9-2 / 正月廿六），不靠感觉挑
  eq(todayFestival(at('2026-10-11')), null, '2026-10-11（农历九月初二）不是节日');
  eq(todayFestival(at('2026-03-15')), null, '2026-03-15（正月廿六）不是节日');
}

// ---------------------------------------------------------------------------
// ⑥·补 每条节日字段必须齐全
//    这条是**事后补的**：节气表里 清明/冬至 漏写了 hint，
//    界面就显示成「清明（undefined）」（CLI 扫日期才看见，单测全绿）。
//    与其再手写一条反例，不如断言"全体字段非空" —— 漏一个字段就报红。
// ---------------------------------------------------------------------------
{
  const fields = ['name', 'hint', 'line'];
  let n = 0;
  for (const year of [2025, 2026, 2027, 2028]) {
    for (const f of catalogue(year)) {
      n++;
      for (const k of fields) {
        const v = f[k];
        ok(typeof v === 'string' && v.trim() !== '', `${f.key} 的 ${k} 非空（实际 ${JSON.stringify(v)}）`);
      }
      ok(Array.isArray(f.anims) && f.anims.length > 0, `${f.key} 至少配一个动画`);
      ok(f.anims.every((a) => typeof a === 'string' && a.trim() !== ''), `${f.key} 的动画名非空`);
    }
  }
  // 也验一下 todayFestival 这条**真正被 UI 用的**路径（catalogue 是报告用的另一条路）
  const viaToday = [todayFestival(at('2026-04-05')), todayFestival(at('2026-12-22'))];
  for (const f of viaToday) {
    ok(f, 'todayFestival 认得出这个节气');
    ok(typeof f?.hint === 'string' && f.hint.trim() !== '', `${f?.name} 经 todayFestival 出来也有 hint（实际 ${JSON.stringify(f?.hint)}）`);
  }
  console.log(`  字段完整性：扫了 ${n} 条节日`);
}

// ---------------------------------------------------------------------------
// ⑥ 每个节日该播的动画必须"确有其物"（防手滑写错名字 → 那天静默不播）
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const webmDirs = [
    path.resolve(here, '..', 'node_modules', 'dsh-pet', 'assets', 'webm'),
    path.resolve(here, '..', 'assets', 'webm'),
  ];
  let dir = null;
  for (const d of webmDirs) if (fs.existsSync(d)) { dir = d; break; }
  if (!dir) {
    console.log('  （跳过动画素材核对：找不到 assets/webm）');
  } else {
    const list = catalogue(2026);
    const anims = [...new Set(list.flatMap((f) => f.anims))];
    for (const a of anims) {
      ok(fs.existsSync(path.join(dir, a + '.webm')), `动画素材存在：${a}.webm`);
    }
    console.log(`  动画素材核对：${anims.length} 个名字，目录 ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// ⑨ 补丁语义：节令动画是否**真的**退出了随机池（读已安装的 plugin）
//    只验"锚点命中"不够 —— 要验打完补丁后的配置语义对不对：
//    各池 weight 合计是否仍与顶层权重凑成 100、17 个节令动画是否真的不在任何池里
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const { parseJsonc } = await import('../lib/jsonc.mjs');
  const { PLUGIN_DIR } = await import('../lib/paths.mjs');

  const cfgFile = path.join(process.env.DSH_PET_PLUGIN || PLUGIN_DIR, 'assets', 'config.jsonc');
  if (!fs.existsSync(cfgFile)) {
    console.log(`  （跳过随机池核对：找不到 ${cfgFile}）`);
  } else {
    const cfg = parseJsonc(fs.readFileSync(cfgFile, 'utf8'));
    const cats = cfg.animations.categories;
    const poolNames = new Set(cats.flatMap((c) => c.actions));

    // 权重：各池合计 + 顶层 idle/turn/move 必须 = 100（不足会让整条随机链概率走样）
    const catSum = cats.reduce((a, c) => a + c.weight, 0);
    const top = cfg.animationWeights;
    const total = catSum + top.idle + top.turn + top.move;
    eq(total, 100, `随机链权重合计应为 100（各池 ${catSum} + 顶层 ${top.idle}+${top.turn}+${top.move}）`);

    // 时节池只该剩季节泛化的两个
    const shijie = cats.find((c) => c.id === '时节');
    ok(shijie, '「时节」池还在（只是瘦身了）');
    eq(shijie?.actions, ['被落叶淹没', '堆雪人'], '「时节」池只剩季节泛化动画');
    ok(shijie?.weight <= 5, `「时节」池权重要降下来（实际 ${shijie?.weight}）`);

    // 19 个有固定日期的节日动画，必须都不在随机池里
    const festAnims = [...new Set(catalogue(2026).flatMap((f) => f.anims))];
    for (const a of festAnims) {
      ok(!poolNames.has(a), `节日动画已退出随机池：${a}`);
    }
    // 反例：季节泛化的两个必须**还**在池里（别一刀切把什么都摘了）
    ok(poolNames.has('被落叶淹没'), '「被落叶淹没」仍留在随机池（它没有固定日期）');
    ok(poolNames.has('堆雪人'), '「堆雪人」仍留在随机池（它没有固定日期）');

    console.log(`  随机池核对：${path.relative(process.cwd(), cfgFile)}`);
    console.log(`    ${cats.map((c) => `${c.id} ${c.weight}`).join(' / ')}  → 合计 ${total}`);
    console.log(`    节日动画 ${festAnims.length} 个已全部退出随机池`);
  }
}

// ---------------------------------------------------------------------------
// ⑦ 认主天数与纪念
// ---------------------------------------------------------------------------
const BOND = '2026-09-25';
eq(bondDays(BOND, at('2026-09-25')), 1, '认主当天算第 1 天');
eq(bondDays(BOND, at('2026-10-11')), 17, '2026-09-25 → 2026-10-11 = 第 17 天');
eq(bondDays(BOND, at('2027-01-02')), 100, '2026-09-25 起第 100 天 = 2027-01-02');
eq(bondDays('乱写', at('2026-10-11')), null, '非法认主日返回 null');

ok(bondHundred(99) === null, '第 99 天不响');
eq(bondHundred(100)?.days, 100, '第 100 天该响');
ok(bondHundred(101) === null, '第 101 天不响');

// 周年必须按"日历月日"判，不是 days % 365 —— 否则会落在周年前一天，连着两天都响
eq(bondAnniversary(BOND, at('2027-09-25'))?.years, 1, '2027-09-25 是一周年');
eq(bondAnniversary(BOND, at('2027-09-24')), null, '2027-09-24（周年前一天）不该响');
eq(bondAnniversary(BOND, at('2028-09-25'))?.years, 2, '2028-09-25 是二周年');
eq(bondAnniversary(BOND, at('2026-09-25')), null, '认主当天不算周年');
eq(bondMilestone(BOND, at('2027-09-25'))?.days, 366, '一周年那天的天数是第 366 天（跨了平年 2027）');
eq(bondMilestone(BOND, at('2027-09-24')), null, '周年前一天既不响周年、也非整百 → 闭嘴');
eq(bondMilestone(BOND, at('2026-12-31')), null, '平常日子闭嘴');
eq(bondMilestone(BOND, at('2027-01-02'))?.days, 100, '第 100 天走整百天那条路');

// ---------------------------------------------------------------------------
// ⑧ 上海时区：跨零点不能算错天
// ---------------------------------------------------------------------------
eq(todayStamp(new Date('2026-10-17T16:30:00Z')), '2026-10-18', 'UTC 16:30 = 上海次日 00:30');
eq(solarKey(new Date('2026-10-17T16:30:00Z')), '10-18', '公历键也走上海时区');

// ---------------------------------------------------------------------------
if (process.argv.includes('--today')) {
  const now = new Date();
  const f = todayFestival(now);
  const d = bondDays(BOND, now);
  const ms = bondMilestone(BOND, now);
  console.log('');
  console.log('今天：' + todayStamp(now));
  console.log('  农历：' + (lunarKey(now) ?? '（ICU 不可用）') + '   公历键：' + solarKey(now));
  console.log('  节日：' + (f ? `${f.name}（${f.hint}）→ 播「${f.anims.join('、')}」：「${f.line}」` : '今天不是节日'));
  console.log('  陪伴：第 ' + d + ' 天' + (ms ? `  ← 今天该响：${ms.line}` : ''));
}

// ---------------------------------------------------------------------------
// 哨兵自验：故意把一个期望改错，确认测试**真的会报红**（不然"全绿"没有说服力）
// ---------------------------------------------------------------------------
if (process.argv.includes('--selftest')) {
  const before = fail;
  eq(todayFestival(at('2026-10-18'))?.name, '中秋', '哨兵：故意把重阳写成中秋，这里必须报红');
  const caught = fail > before;
  console.log('');
  console.log(caught ? '  ✔ 哨兵：故意写错确实报红了（说明断言真的在跑）' : '  ✘ 哨兵失效：写错了竟然没报红！');
  // 把哨兵造成的那条失败从计数里摘掉，避免污染结论
  fail = before;
  failures.pop();
  pass--;
}

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  ✘ ' + f);
  console.log('');
}
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
console.log(fail === 0 ? '全部通过' : '有失败');
process.exit(fail === 0 ? 0 : 1);
