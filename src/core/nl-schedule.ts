/**
 * 自然语言调度解析 — 中文时间表达 → cron 5 字段
 * 覆盖：每 N 分钟/小时、每小时、每天/每日、每周X（含区间）、每工作日/每周末、每月X号（均接受「每个」前缀）
 *       时间词（凌晨/早上/上午/中午/下午/晚上等）+ 整点/半点/X点X分/X:XX
 * 规则解析失败返回 null（调用方可选 LLM 兜底，但必须用 reconcileCron 校验兜底结果——见下）
 */

export interface NaturalSchedule {
  cron: string;
  prompt: string;
}

/** 时间词正则片段（"晚"单字覆盖"每晚10点"） */
const TIME_WORD = "凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚|夜里|夜晚|半夜|午夜";

const CN_DOW: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 「每」与时间单位之间可插「个」（每个周六 / 每个工作日 / 每个月1号） */
const GE = "每\\s*个?\\s*";

/** 解析时刻：返回 [HH, MM] 与匹配文本；找不到返回 null */
function parseClock(text: string): { hour: number; minute: number; match: string } | null {
  const base = new RegExp(`(${TIME_WORD})?\\s*(\\d{1,2})\\s*[:：点时](\\d{1,2})\\s*分?`).exec(text);
  if (base) {
    let hour = parseInt(base[2]!, 10);
    const minute = parseInt(base[3]!, 10);
    if (minute > 59 || hour > 23) return null;
    const word = base[1];
    if (word && hour < 12 && (word === "下午" || word === "晚上" || word === "晚" || word === "傍晚" || word === "夜里" || word === "夜晚" || word === "半夜")) {
      hour += 12;
    }
    return { hour, minute, match: base[0]! };
  }
  // 整点：X点 / X点半 / X点刻 / X点N分
  const whole = new RegExp(`(${TIME_WORD})?\\s*(\\d{1,2})\\s*点(半|刻|(\\d{1,2})\\s*分?)?`).exec(text);
  if (whole) {
    let hour = parseInt(whole[2]!, 10);
    if (hour > 23) return null;
    const word = whole[1];
    if (word && hour < 12 && (word === "下午" || word === "晚上" || word === "晚" || word === "傍晚" || word === "夜里" || word === "夜晚" || word === "半夜")) {
      hour += 12;
    }
    const tail = whole[3];
    let minute = 0;
    if (tail === "半") minute = 30;
    else if (tail === "刻") minute = 15;
    else if (tail && /^\d+$/.test(tail)) minute = parseInt(tail, 10);
    if (minute > 59) return null;
    return { hour, minute, match: whole[0]! };
  }
  return null;
}

/** 星期区间："每周一到周五" / "每个周一至周五"（两端的写法都要接受「天/日」） */
const DOW_RANGE_RE = new RegExp(`${GE}周\\s*([一二三四五六日天1-7])\\s*(?:到|至)\\s*(?:周|星期|礼拜)?\\s*([一二三四五六日天1-7])`);
/** 单个星期："每周六" / "每个周六" */
const DOW_SINGLE_RE = new RegExp(`${GE}周\\s*([一二三四五六日天1-7])`);
/** 线索用（不要求「每」前缀）：任意位置的 "周六" / "周一到周五"（"每逢周六"、"提醒我周六跑步" 都算） */
const DOW_CUE_RANGE_RE = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])\s*(?:到|至)\s*(?:周|星期|礼拜)?\s*([一二三四五六日天1-7])/;
const DOW_CUE_RE = /(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/;
/** 工作日 / 周末 */
const WORKDAY_RE = new RegExp(`每?\\s*个?\\s*工作日`);
const WEEKEND_RE = new RegExp(`每?\\s*个?\\s*周末`);
/** 每天 / 每日 / 每晚 / 天天 */
const DAILY_RE = new RegExp(`${GE}(?:天|日|晚)|天天`);
/** 每月 X 号 */
const DOM_RE = new RegExp(`${GE}月\\s*(\\d+)\\s*[号日]`);

/** 解析频率：返回 cron 的分/时/日/月/周片段组合；找不到返回 null */
function parseFrequency(text: string): { fields: string[]; match: string } | null {
  // 每 N 分钟
  const m1 = new RegExp(`${GE}(\\d+)\\s*分钟`).exec(text);
  if (m1) return { fields: [`*/${m1[1]}`, "*", "*", "*", "*"], match: m1[0]! };
  // 每半小时 / 每 30 分钟
  const m2 = new RegExp(`${GE}半小时|${GE}30\\s*分钟`).exec(text);
  if (m2) return { fields: ["*/30", "*", "*", "*", "*"], match: m2[0]! };
  // 每 N 小时
  const m3 = new RegExp(`${GE}(\\d+)\\s*个?小时`).exec(text);
  if (m3) return { fields: ["0", `*/${m3[1]}`, "*", "*", "*"], match: m3[0]! };
  // 每小时
  const m4 = new RegExp(`${GE}小时`).exec(text);
  if (m4) return { fields: ["0", "*", "*", "*", "*"], match: m4[0]! };
  // 每月 X 号
  const m5 = DOM_RE.exec(text);
  if (m5) return { fields: ["0", "0", m5[1]!, "*", "*"], match: m5[0]! };
  // 每周 X 到 Y
  const m6 = DOW_RANGE_RE.exec(text);
  if (m6) {
    const a = CN_DOW[m6[1]!] ?? parseInt(m6[1]!, 10);
    const b = CN_DOW[m6[2]!] ?? parseInt(m6[2]!, 10);
    // 反序区间（"周天到周五"）会生成 cron-parser 拒绝的 `7-5` → 不采纳，继续走单日/其它分支
    if (a >= 1 && b >= 1 && a <= 7 && b <= 7 && a <= b) {
      return { fields: ["0", "0", "*", "*", `${a}-${b}`], match: m6[0]! };
    }
  }
  // 每周 X
  const m7 = DOW_SINGLE_RE.exec(text);
  if (m7) {
    const d = CN_DOW[m7[1]!] ?? parseInt(m7[1]!, 10);
    if (d >= 1 && d <= 7) {
      const dow = d === 7 ? 0 : d;
      return { fields: ["0", "0", "*", "*", String(dow)], match: m7[0]! };
    }
  }
  // 每工作日 / 工作日
  const m8 = WORKDAY_RE.exec(text);
  if (m8) return { fields: ["0", "0", "*", "*", "1-5"], match: m8[0]! };
  // 每周末 / 周末
  const m9 = WEEKEND_RE.exec(text);
  if (m9) return { fields: ["0", "0", "*", "*", "0,6"], match: m9[0]! };
  // 每天 / 每日 / 每晚 / 天天
  const m10 = DAILY_RE.exec(text);
  if (m10) return { fields: ["0", "0", "*", "*", "*"], match: m10[0]! };
  return null;
}

/** 原句里可确定的时间线索（用于校验/修补外部给出的 cron） */
export interface ScheduleCues {
  minute: number | null;
  hour: number | null;
  dayOfMonth: number | null;
  /** cron 星期字段（0-7，7 已归一为 0）；null = 原句未指明 */
  dow: string | null;
  /** 原句明确说了"每天/每日/每晚" */
  daily: boolean;
}

export function extractCues(text: string): ScheduleCues {
  const clock = parseClock(text);
  const dom = DOM_RE.exec(text);
  let dow: string | null = null;
  let rangeSeen = false;
  const range = DOW_CUE_RANGE_RE.exec(text);
  if (range) {
    rangeSeen = true;
    const a = CN_DOW[range[1]!] ?? parseInt(range[1]!, 10);
    const b = CN_DOW[range[2]!] ?? parseInt(range[2]!, 10);
    // a > b（如"周天到周五"）语义是跨周回绕，cron 的 a-b 会被 cron-parser 判为无效 → 视为无线索，不参与修补
    if (a >= 1 && b >= 1 && a <= 7 && b <= 7 && a <= b) dow = `${a}-${b}`;
  }
  if (!dow && WORKDAY_RE.test(text)) dow = "1-5";
  if (!dow && WEEKEND_RE.test(text)) dow = "0,6";
  // 区间写法存在但不合法（反序）时不再退到"取第一个单日"——歧义输入宁可不动，避免自信地改错
  if (!dow && !rangeSeen) {
    const single = DOW_CUE_RE.exec(text);
    if (single) {
      const d = CN_DOW[single[1]!] ?? parseInt(single[1]!, 10);
      if (d >= 1 && d <= 7) dow = String(d === 7 ? 0 : d);
    }
  }
  return {
    minute: clock ? clock.minute : null,
    hour: clock ? clock.hour : null,
    dayOfMonth: dom ? parseInt(dom[1]!, 10) : null,
    dow,
    daily: !dow && DAILY_RE.test(text),
  };
}

/**
 * 用原句线索校验并修补 cron（LLM 兜底必经此步）
 * 只改"原句明确说了"的字段；原句未提及的字段保留传入值（例如模型自选的时刻）。
 * 间隔/枚举类字段（`*`、`星号斜杠N`、`a-b`、`a,b`）不按时刻线索覆盖——否则"9点每30分钟"会被改成"每天9点"。
 */
export function reconcileCron(text: string, cron: string): { cron: string; notes: string[] } {
  const cues = extractCues(text);
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return { cron, notes: [] };
  const base = parts.length === 6 ? 1 : 0;
  const notes: string[] = [];
  /** 目标字段是具体值（纯数字），才允许被原句线索覆盖 */
  const isPlain = (field: string) => /^\d+$/.test(field);

  if (cues.minute !== null && parts[base] !== String(cues.minute)) {
    if (isPlain(parts[base]!)) {
      parts[base] = String(cues.minute);
      notes.push(`分钟按原句改为 ${cues.minute}`);
    } else {
      notes.push(`保留模型给出的分钟字段「${parts[base]}」（原句另有间隔表达，未按时刻覆盖）`);
    }
  }
  if (cues.hour !== null && parts[base + 1] !== String(cues.hour)) {
    if (isPlain(parts[base + 1]!)) {
      parts[base + 1] = String(cues.hour);
      notes.push(`小时按原句改为 ${cues.hour}`);
    } else {
      notes.push(`保留模型给出的小时字段「${parts[base + 1]}」（原句另有间隔表达，未按时刻覆盖）`);
    }
  }
  if (cues.dayOfMonth !== null && parts[base + 2] !== String(cues.dayOfMonth) && isPlain(parts[base + 2]!)) {
    parts[base + 2] = String(cues.dayOfMonth);
    notes.push(`日期按原句改为 ${cues.dayOfMonth} 号`);
  }
  if (cues.daily) {
    if (parts[base + 2] !== "*") {
      parts[base + 2] = "*";
      notes.push("按原句「每天」清掉日期限定");
    }
    if (parts[base + 4] !== "*") {
      parts[base + 4] = "*";
      notes.push("按原句「每天」清掉星期限定");
    }
  } else if (cues.dow !== null && parts[base + 4] !== cues.dow) {
    parts[base + 4] = cues.dow;
    notes.push(`星期按原句改为 ${cues.dow === "0" ? "周日" : cues.dow}`);
  }
  return { cron: parts.join(" "), notes };
}

const HEAD_PUNCT = /^[\s，。、,.;；：:！!？?~～-]+/;
const TAIL_PUNCT = /[\s，。、,.;；：:！!？?~～-]+$/;

/** 剥离时间/频率表达并清理残留标点（"每周六，提醒我…" → "提醒我…"） */
export function stripScheduleWords(text: string): { prompt: string; matched: boolean } {
  const trimmed = text.trim();
  const clock = parseClock(trimmed);
  const freq = parseFrequency(trimmed);
  const intervals: Array<[number, number]> = [];
  for (const m of [clock?.match, freq?.match]) {
    if (!m) continue;
    const idx = trimmed.indexOf(m);
    if (idx !== -1) intervals.push([idx, idx + m.length]);
  }
  if (intervals.length === 0) return { prompt: trimmed.replace(/\s+/g, " ").trim(), matched: false };
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  let cursor = 0;
  let out = "";
  for (const [s, e] of merged) {
    out += trimmed.slice(cursor, s);
    cursor = e;
  }
  out += trimmed.slice(cursor);
  // 只在"被剥离的片段贴着句子边界"时清首/尾标点：否则会吃掉任务名自带的结尾标点（"检查 a.b."）
  const touchesHead = merged[0]![0] === 0;
  const touchesTail = merged[merged.length - 1]![1] >= trimmed.length;
  let prompt = out.replace(/\s+/g, " ");
  if (touchesHead) prompt = prompt.replace(HEAD_PUNCT, "");
  if (touchesTail) prompt = prompt.replace(TAIL_PUNCT, "");
  return { prompt: prompt.trim(), matched: true };
}

/**
 * 解析自然语言调度需求。
 * 支持："每天早上8点生成早报" / "每个周六提醒我运动" / "每30分钟检查一次" / "每周一上午9点提醒" / "每月1号8点"
 * 无频率默认每天；无法识别返回 null。
 */
export function parseNaturalSchedule(text: string): NaturalSchedule | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const clock = parseClock(trimmed);
  const freq = parseFrequency(trimmed);

  // 既无时刻也无频率 → 不是调度需求（如"帮我写个程序"）
  if (!clock && !freq) return null;

  let minute = "0";
  let hour = "0";
  if (clock) {
    minute = String(clock.minute);
    hour = String(clock.hour);
  }

  // 组合 cron：分钟/小时频率优先（忽略时刻），否则按时分拼接
  let cron: string;
  if (freq && (freq.fields[0]!.startsWith("*/") || freq.fields[1]!.startsWith("*/"))) {
    cron = freq.fields.join(" ");
  } else if (freq) {
    const [fMin, fHour, day, month, dow] = freq.fields;
    cron = `${fMin === "0" ? minute : fMin} ${fHour === "0" ? hour : fHour} ${day} ${month} ${dow}`;
  } else {
    // 无频率：默认每天
    cron = `${minute} ${hour} * * *`;
  }

  // 仅在规则没认出频率时才用线索兜底（"每逢周六下午3点"这类只命中时刻的输入）
  // 已有频率时不覆盖：否则任务正文里的星期词（"每天9点提醒我周六有活动"）会被误当调度线索
  if (!freq) cron = reconcileCron(trimmed, cron).cron;

  const { prompt } = stripScheduleWords(trimmed);
  if (!prompt) return null;

  return { cron, prompt };
}
