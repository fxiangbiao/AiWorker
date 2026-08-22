/**
 * 自然语言调度解析 — 中文时间表达 → cron 5 字段
 * 覆盖：每 N 分钟/小时、每小时、每天/每日、每周X（含区间）、每工作日/每周末、每月X号
 *       时间词（凌晨/早上/上午/中午/下午/晚上等）+ 整点/半点/X点X分/X:XX
 * 规则解析失败返回 null（调用方可选 LLM 兜底）
 */

export interface NaturalSchedule {
  cron: string;
  prompt: string;
}

/** 时间词正则片段（"晚"单字覆盖"每晚10点"） */
const TIME_WORD = "凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚|夜里|夜晚|半夜|午夜";

const CN_DOW: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

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

/** 解析频率：返回 cron 的分/时/日/月/周片段组合；找不到返回 null */
function parseFrequency(text: string): { fields: string[]; match: string } | null {
  // 每 N 分钟
  const m1 = /每\s*(\d+)\s*分钟/.exec(text);
  if (m1) return { fields: [`*/${m1[1]}`, "*", "*", "*", "*"], match: m1[0]! };
  // 每半小时 / 每 30 分钟
  const m2 = /每\s*半小时|每\s*30\s*分钟/.exec(text);
  if (m2) return { fields: ["*/30", "*", "*", "*", "*"], match: m2[0]! };
  // 每 N 小时
  const m3 = /每\s*(\d+)\s*个?小时/.exec(text);
  if (m3) return { fields: ["0", `*/${m3[1]}`, "*", "*", "*"], match: m3[0]! };
  // 每小时
  const m4 = /每\s*小时/.exec(text);
  if (m4) return { fields: ["0", "*", "*", "*", "*"], match: m4[0]! };
  // 每月 X 号
  const m5 = /每\s*个?月\s*(\d+)\s*[号日]/.exec(text);
  if (m5) return { fields: ["0", "0", m5[1]!, "*", "*"], match: m5[0]! };
  // 每周 X 到 Y（"每周一到周五" / "每周一至周五"）
  const m6 = /每\s*周\s*([一二三四五六日天1-7])\s*(?:到|至)\s*(?:周)?\s*([一二三四五六日1-7])/.exec(text);
  if (m6) {
    const a = CN_DOW[m6[1]!] ?? parseInt(m6[1]!, 10);
    const b = CN_DOW[m6[2]!] ?? parseInt(m6[2]!, 10);
    if (a >= 1 && b >= 1 && a <= 7 && b <= 7) {
      return { fields: ["0", "0", "*", "*", `${a}-${b}`], match: m6[0]! };
    }
  }
  // 每周 X
  const m7 = /每\s*周\s*([一二三四五六日天1-7])/.exec(text);
  if (m7) {
    const d = CN_DOW[m7[1]!] ?? parseInt(m7[1]!, 10);
    if (d >= 1 && d <= 7) {
      const dow = d === 7 ? 0 : d;
      return { fields: ["0", "0", "*", "*", String(dow)], match: m7[0]! };
    }
  }
  // 每工作日 / 工作日
  const m8 = /每?\s*工作日/.exec(text);
  if (m8) return { fields: ["0", "0", "*", "*", "1-5"], match: m8[0]! };
  // 每周末 / 周末
  const m9 = /每?\s*周末/.exec(text);
  if (m9) return { fields: ["0", "0", "*", "*", "0,6"], match: m9[0]! };
  // 每天 / 每日 / 每晚 / 天天
  const m10 = /每\s*天|每\s*日|每晚|天天/.exec(text);
  if (m10) return { fields: ["0", "0", "*", "*", "*"], match: m10[0]! };
  return null;
}

/**
 * 解析自然语言调度需求。
 * 支持："每天早上8点生成早报" / "每30分钟检查一次" / "每周一上午9点提醒" / "每月1号8点"
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

  // 任务描述：按原始索引剥离已匹配片段（区间合并，防"每晚10点"类词重叠）
  let prompt = trimmed;
  const intervals: Array<[number, number]> = [];
  for (const m of [clock?.match, freq?.match]) {
    if (!m) continue;
    const idx = trimmed.indexOf(m);
    if (idx !== -1) intervals.push([idx, idx + m.length]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  if (merged.length > 0) {
    let cursor = 0;
    let out = "";
    for (const [s, e] of merged) {
      out += trimmed.slice(cursor, s);
      cursor = e;
    }
    out += trimmed.slice(cursor);
    prompt = out;
  }
  prompt = prompt.replace(/\s+/g, " ").trim();
  if (!prompt) return null;

  return { cron, prompt };
}
