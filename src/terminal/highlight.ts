/**
 * 代码块语法高亮 — 逐行 tokenize，输出 ANSI 字符串
 * 自研轻量 tokenizer，不引入重依赖
 * 策略：字符串/注释先保护占位，再着色其余 token，避免误判
 */

import chalk from "chalk";

const JS_KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|this|static|get|set)\b/;
const PY_KEYWORDS =
  /\b(def|class|return|if|elif|else|for|while|try|except|finally|import|from|as|with|lambda|pass|break|continue|global|nonlocal|raise|yield|assert|del|in|is|not|and|or|None|True|False)\b/;
const SQL_KEYWORDS =
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|ALTER|DROP|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|VALUES|INTO|SET|AS|AND|OR|NOT|NULL|DISTINCT|COUNT|SUM|AVG|MIN|MAX|BETWEEN|LIKE|IN|IS|ASC|DESC|UNION|ALL)\b/;
const JS_TYPES =
  /\b(string|number|boolean|object|array|void|any|unknown|never|interface|type|enum|namespace|readonly|Promise|Map|Set|Array|String|Number|Boolean|console)\b/;
const BOOL_NULL = /\b(true|false|null|undefined|None|True|False|nil)\b/;
const NUMBER = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/;

const COMMENT_LINE = /(\/\/.*$)|(#.*$)|(--.*$)|(<!--.*$)|(\/\*.*$)/;
const STRING_RE = /(["'`][^"'`]*["'`])/g;

interface LanguageRule {
  keywords: RegExp;
  types: RegExp | null;
  commentLine: RegExp;
}

const rules: Record<string, LanguageRule> = {
  typescript: { keywords: JS_KEYWORDS, types: JS_TYPES, commentLine: COMMENT_LINE },
  javascript: { keywords: JS_KEYWORDS, types: JS_TYPES, commentLine: COMMENT_LINE },
  ts: { keywords: JS_KEYWORDS, types: JS_TYPES, commentLine: COMMENT_LINE },
  js: { keywords: JS_KEYWORDS, types: JS_TYPES, commentLine: COMMENT_LINE },
  python: { keywords: PY_KEYWORDS, types: null, commentLine: /(#.*$)/ },
  py: { keywords: PY_KEYWORDS, types: null, commentLine: /(#.*$)/ },
  sql: { keywords: SQL_KEYWORDS, types: null, commentLine: /(--.*$)/ },
  json: { keywords: /\b(true|false|null)\b/, types: null, commentLine: /(?!x)x/ },
  html: { keywords: /<\/?[a-zA-Z][^>]*>/, types: null, commentLine: /(<!--.*$)/ },
  css: { keywords: /\b(?:[a-zA-Z-]+)\s*:/, types: null, commentLine: /(\/\*.*$)/ },
  bash: { keywords: /\b(if|then|else|fi|for|while|do|done|function|return|export|local|echo|cd|ls|mkdir|rm|cp|mv|sudo|apt|npm|node|git)\b/, types: null, commentLine: /(#.*$)/ },
  shell: { keywords: /\b(if|then|else|fi|for|while|do|done|function|return|export|local|echo|cd|ls|mkdir|rm|cp|mv|sudo|apt|npm|node|git)\b/, types: null, commentLine: /(#.*$)/ },
};

const genericRule: LanguageRule = {
  keywords: /\b(const|let|var|function|return|if|else|for|while|class|import|export|def|true|false|null|undefined)\b/,
  types: null,
  commentLine: COMMENT_LINE,
};

/** 对单行代码做语法高亮。lang 为空时用通用规则。 */
export function highlightLine(line: string, lang?: string): string {
  if (!line.trim()) return line;

  const rule = (lang ? rules[lang.toLowerCase()] : undefined) ?? genericRule;
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\x1b\[\d+(;\d+)*m/g, "");

  // 1. 注释保护（整体着色）
  const commentMatch = clean.match(rule.commentLine);
  if (commentMatch && commentMatch[0]) {
    const idx = clean.indexOf(commentMatch[0]);
    const prefix = clean.slice(0, idx);
    const comment = commentMatch[0];
    return `${colorize(prefix, rule)}${chalk.gray.italic(comment)}`;
  }

  return colorize(clean, rule);
}

function colorize(text: string, rule: LanguageRule): string {
  if (!text.trim()) return text;

  // 2. 字符串保护占位（用 S 前缀，避免与数字正则 \b\d+\b 冲突）
  const strings: string[] = [];
  const placeholder = (s: string): string => {
    strings.push(s);
    return `\u0000S${strings.length - 1}\u0000`;
  };
  let masked = text.replace(STRING_RE, (_m, s) => placeholder(s));

  // 3. 数字
  masked = masked.replace(NUMBER, (m) => `\u0001${m}\u0001`);

  // 4. 布尔/null
  masked = masked.replace(BOOL_NULL, (m) => `\u0002${m}\u0002`);

  // 5. 类型
  if (rule.types) {
    masked = masked.replace(rule.types, (m) => `\u0003${m}\u0003`);
  }

  // 6. 关键字
  masked = masked.replace(rule.keywords, (m) => `\u0004${m}\u0004`);

  // 7. 还原着色（用 String.fromCharCode 构建控制字符正则，避免字面量）
  const C = String.fromCharCode;
  let result = masked;
  result = result.replace(new RegExp(`${C(4)}([^${C(4)}]+)${C(4)}`, "g"), (_, m) => chalk.magenta(m));
  result = result.replace(new RegExp(`${C(3)}([^${C(3)}]+)${C(3)}`, "g"), (_, m) => chalk.blue(m));
  result = result.replace(new RegExp(`${C(2)}([^${C(2)}]+)${C(2)}`, "g"), (_, m) => chalk.yellow(m));
  result = result.replace(new RegExp(`${C(1)}([^${C(1)}]+)${C(1)}`, "g"), (_, m) => chalk.blue(m));
  result = result.replace(new RegExp(`${C(0)}S(\\d+)${C(0)}`, "g"), (_m, idx) => chalk.green(strings[Number(idx)]));

  return result;
}
