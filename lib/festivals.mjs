/**
 * festivals.mjs —— 「器灵应节」：今天是哪个节、该播哪段动画、该说哪句话。
 *
 * 背景（为什么要有这个文件）：
 *   dsh-pet 原生的 animations.categories 里有个叫「时节」的随机池，装了 21 个节令动画
 *   （16 个中国传统 + 万圣/圣诞/雪人/落叶）。**但代码里没有任何日期逻辑** ——
 *   `grep -ri "lunar|农历|节日|festival"` 在 lib/ 与 runtime/ 下零命中，
 *   唯一的消费点是 pickWeightedCategory() 的加权随机抽。
 *   也就是说：中秋可能堆雪人、端午可能吃月饼。
 *
 *   这个模块补的就是那块缺的日历。那 19 个有固定日期的动画已由补丁从随机池摘出
 *   （见 lib/patch.mjs 的 festival-* 规则），只由这里在当天显式触发。
 *
 * 三种日期来源，各用最稳的一条路：
 *   ① 农历节日 → **Node 内置 ICU 的中国历法**，零数据表、零依赖、不必逐年维护：
 *        new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {...})
 *      闰月会输出 `闰6-1` 这种键，跟常规的 `6-1` 天然区分 —— 传统节日都不过闰月，正好。
 *   ② 节气（清明 / 冬至）→ ICU 不提供节气，用 21 世纪通用的「寿星公式」：
 *        日 = ⌊Y×0.2422 + C⌋ − ⌊Y/4⌋      （Y = 年份后两位；清明 C=4.81，冬至 C=21.94）
 *      已拿真实交节时刻核对：2021~2026 清明、2024~2026 冬至 全部命中。
 *   ③ 公历固定（万圣夜 / 圣诞）→ 直接查表。
 *   另：除夕 = 春节（正月初一）的**前一天**单独算 —— 腊月是廿九还是三十不固定，写死必然错。
 *
 * 降级：ICU 万一不认中国历法（`chinese` 日历缺失的构建），lunarKey() 返回 null，
 * 整个模块退化成"只有公历节日和节气"，**但绝不抛异常、绝不拖垮宿主**。
 */

const TZ = 'Asia/Shanghai';

// ---------------------------------------------------------------------------
// 农历 / 公历 日期键
// ---------------------------------------------------------------------------
let lunarFmt = null;
let lunarOk = true;

function getLunarFmt() {
  if (!lunarOk) return null;
  if (lunarFmt) return lunarFmt;
  try {
    lunarFmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      month: 'numeric', day: 'numeric', timeZone: TZ,
    });
    // 探一次，确认这个构建真的支持 chinese 日历
    lunarFmt.formatToParts(new Date());
  } catch {
    lunarOk = false;
    lunarFmt = null;
  }
  return lunarFmt;
}

const mdFmt = new Intl.DateTimeFormat('en-GB', { month: '2-digit', day: '2-digit', timeZone: TZ });
const yearFmt = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: TZ });

function two(n) { return String(n).padStart(2, '0'); }

/** 公历键 `MM-DD`（按 Asia/Shanghai 的日历日，不看 UTC） */
export function solarKey(d = new Date()) {
  const p = mdFmt.formatToParts(d);
  const m = p.find((x) => x.type === 'month')?.value;
  const day = p.find((x) => x.type === 'day')?.value;
  return m && day ? `${m}-${day}` : null;
}

/** 公历年（按 Asia/Shanghai） */
export function solarYear(d = new Date()) {
  return Number(yearFmt.format(d));
}

/** 农历键 `M-D`；闰月是 `闰M-D`。ICU 不可用时返回 null。 */
export function lunarKey(d = new Date()) {
  const f = getLunarFmt();
  if (!f) return null;
  try {
    const p = f.formatToParts(d);
    const m = p.find((x) => x.type === 'month')?.value;
    const day = p.find((x) => x.type === 'day')?.value;
    return m && day ? `${m}-${day}` : null;
  } catch {
    return null;
  }
}

/** 加整天数（中国无夏令时，直接加 24h 就是"明天同一时刻"） */
export function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

/** 上海时区的"当天零点"时间戳 —— 用来算整天差，避免跨时区/跨时段算错 */
function dayAnchor(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ,
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value;
  const y = Number(get('year')), m = Number(get('month')), dd = Number(get('day'));
  // 用 UTC 承载"日历日"，纯粹为了做整数天差
  return Date.UTC(y, m - 1, dd);
}

/**
 * 陪伴天数：认主当天算**第 1 天**。
 * @param {string} since `YYYY-MM-DD`
 * @param {Date}   now
 * @returns {number|null}
 */
export function bondDays(since, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(since || ''));
  if (!m) return null;
  const a = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const b = dayAnchor(now);
  const n = Math.round((b - a) / 86400000);
  return n >= 0 ? n + 1 : null;
}

/** 上海时区的 `YYYY-MM-DD` —— 存"今天已经说过了"的账本用 */
export function todayStamp(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ,
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---------------------------------------------------------------------------
// 节气：21 世纪通用的寿星公式
// ---------------------------------------------------------------------------
/**
 * 节气落在公历几月几号。同一个月内可能有两个节气（清明/谷雨都在 4 月），
 * 所以这里按"节气名"给常数和月份，不是按月份反推。
 */
const SOLAR_TERMS = {
  清明: { month: 4, c: 4.81 },
  冬至: { month: 12, c: 21.94 },
};

/** 某年的节气落在 `MM-DD`（按公式算，已核对真实交节日期） */
export function solarTermKey(name, year) {
  const t = SOLAR_TERMS[name];
  if (!t) return null;
  const Y = year % 100;
  const day = Math.floor(Y * 0.2422 + t.c) - Math.floor(Y / 4);
  return `${two(t.month)}-${two(day)}`;
}

// ---------------------------------------------------------------------------
// 节日表
// ---------------------------------------------------------------------------
/**
 * 农历节日（键 = lunarKey 的输出）。
 * anims 全部来自 dsh-pet 原生素材，**一个都不需要另做**（assets/webm/ 下 106 个 webm 里就有）。
 * line 是它当天要说的一句话 —— 语气刻意写得平实、有点古意，不卖萌。
 */
const LUNAR_FESTIVALS = {
  '1-1': { name: '春节', hint: '正月初一', anims: ['收红包', '写福字', '舞狮头', '吃年糕'], line: '又一年了。福字我替你写好了。' },
  '1-15': { name: '元宵', hint: '正月十五', anims: ['吃汤圆', '放孔明灯'], line: '灯都亮起来了，多看一会儿。' },
  '5-5': { name: '端午', hint: '五月初五', anims: ['吃粽子'], line: '粽子在锅里了。今天别下水。' },
  '7-7': { name: '七夕', hint: '七月初七', anims: ['穿针乞巧'], line: '今晚的针线活归我，你歇着。' },
  '7-15': { name: '中元', hint: '七月十五', anims: ['放河灯'], line: '河灯顺水走，不用怕。' },
  '8-15': { name: '中秋', hint: '八月十五', anims: ['中秋赏月吃月饼'], line: '月亮圆了。月饼分你一半。' },
  '9-9': { name: '重阳', hint: '九月初九', anims: ['插茱萸赏菊', '吃重阳糕'], line: '登高去。茱萸我替你带上。' },
  '12-8': { name: '腊八', hint: '腊月初八', anims: ['吃腊八粥'], line: '粥熬好了，趁热。' },
};

/** 节气节日（清明、冬至）—— 键由 solarTermKey() 算出来 */
const TERM_FESTIVALS = {
  清明: { name: '清明', hint: '太阳黄经 15°', anims: ['吃青团'], line: '雨要下一阵。青团是甜的。' },
  冬至: { name: '冬至', hint: '太阳黄经 270°', anims: ['吃饺子'], line: '夜最长的一天。饺子吃了就不冷。' },
};

/** 公历固定节日 */
const SOLAR_FESTIVALS = {
  '10-31': { name: '万圣夜', hint: '10 月 31 日', anims: ['讨糖南瓜灯', '萌化小幽灵'], line: '糖给你，别敲门了。' },
  '12-25': { name: '圣诞', hint: '12 月 25 日', anims: ['装点圣诞树'], line: '树我装好了。礼物呢？' },
};

/** 除夕：春节前一天。腊月是廿九还是三十逐年不同，所以只能"看明天是不是正月初一"。 */
const EVE = { name: '除夕', hint: '腊月最后一天', anims: ['放烟花'], line: '这一年收起来吧。烟花给你放。' };

// ---------------------------------------------------------------------------
// 主查询
// ---------------------------------------------------------------------------
/**
 * 今天是什么节？不是节日就返回 null。
 * @returns {{key:string,name:string,hint:string,anims:string[],line:string}|null}
 */
export function todayFestival(now = new Date()) {
  // ① 除夕优先判：它是"春节前一天"，用明天的农历键来认
  if (lunarKey(addDays(now, 1)) === '1-1') {
    return { key: '除夕', ...EVE };
  }

  // ② 节气（清明 / 冬至）
  const sk = solarKey(now);
  if (sk) {
    const y = solarYear(now);
    for (const name of Object.keys(TERM_FESTIVALS)) {
      if (solarTermKey(name, y) === sk) return { key: name, ...TERM_FESTIVALS[name] };
    }
  }

  // ③ 农历节日
  const lk = lunarKey(now);
  if (lk && LUNAR_FESTIVALS[lk]) return { key: lk, ...LUNAR_FESTIVALS[lk] };

  // ④ 公历节日
  if (sk && SOLAR_FESTIVALS[sk]) return { key: sk, ...SOLAR_FESTIVALS[sk] };

  return null;
}

/**
 * 认主周年：靠**日历月日相同**判，不靠天数整除 ——
 * 认主当天算第 1 天，所以一周年其实是第 366 天（跨闰年还要 +1）。
 * 用 `days % 365 === 0` 判会落在周年前一天，变成连着两天都响。
 * @returns {{years:number,days:number,line:string}|null}
 */
export function bondAnniversary(since, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(since || ''));
  if (!m) return null;
  const st = todayStamp(now);
  if (st.slice(5) !== `${m[2]}-${m[3]}`) return null;
  const years = Number(st.slice(0, 4)) - Number(m[1]);
  if (years < 1) return null;
  const days = bondDays(since, now);
  return { years, days, line: `第 ${years} 年了。我还在。` };
}

/** 整百天纪念（100/200/300…）。周年由 bondAnniversary 管，两者不会同时命中。 */
export function bondHundred(days) {
  if (!Number.isFinite(days) || days < 100 || days % 100 !== 0) return null;
  return { days, line: `第 ${days} 天了。我还在这儿。` };
}

/**
 * 认主纪念的唯一入口：周年优先，其次整百天，其余日子闭嘴。
 * 目的是"一年响三五次"（100/200/300 + 周年），不是天天报数。
 * @returns {{days:number,line:string}|null}
 */
export function bondMilestone(since, now = new Date()) {
  const ann = bondAnniversary(since, now);
  if (ann) return { days: ann.days, line: ann.line };
  return bondHundred(bondDays(since, now));
}

/** 自检用：把本模块支持的节日全列出来（含按公式算出的节气） */
export function catalogue(year = solarYear()) {
  const out = [];
  for (const [k, v] of Object.entries(LUNAR_FESTIVALS)) out.push({ key: k, kind: '农历', ...v });
  out.push({ key: '除夕', kind: '农历', ...EVE });
  for (const name of Object.keys(TERM_FESTIVALS)) {
    out.push({ key: solarTermKey(name, year), kind: '节气', ...TERM_FESTIVALS[name] });
  }
  for (const [k, v] of Object.entries(SOLAR_FESTIVALS)) out.push({ key: k, kind: '公历', ...v });
  return out;
}
