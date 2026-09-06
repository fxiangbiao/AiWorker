/**
 * tui.ts — TUI 主控制器
 *
 * 组合 MessageList + InputLine + StatusBar，用 Screen 差分渲染。
 * 全帧合成：消息区（rows-2）+ 输入行 + 状态栏。
 * requestRender() 16ms 节流。
 *
 * 状态栏是每帧固定组成 → 每次渲染都重画，物理上不会消失。
 */

import { Screen } from "./screen.js";
import { Terminal, type KeyEvent } from "./term.js";
import { MessageList, InputLine, StatusBar, type StatusData } from "./components.js";
import { parseOptionInput } from "../tools/ask-channel.js";
import { TurnView, type AskBlock } from "./turn-view.js";
import chalk from "chalk";

export class Tui {
  readonly screen = new Screen();
  readonly terminal = new Terminal();
  readonly messages = new MessageList();
  readonly input = new InputLine();
  readonly status = new StatusBar();

  private active = false;
  private renderPending = false;
  private promptResolve: ((v: string) => void) | null = null;
  private promptActive = false;
  private agentRunning = false;
  private onInterrupt: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private realWrite: ((s: string) => void) | null = null;
  private capturedWrite: typeof process.stdout.write | null = null;
  private completionHints: string[] = [];
  /** 输入区当前可视行数（renderNow 更新，消息区高度计算用） */
  private inputHeight = 1;
  /** ask_user 等待回答状态（输入行「答> 」编辑，Enter 提交） */
  private askPending = false;
  private askResolve: ((v: string | null) => void) | null = null;
  private askTimer: ReturnType<typeof setTimeout> | null = null;
  private askOptions: string[] = [];
  private askMultiple = false;
  /** 多选：当前高亮选项索引 + 勾选集合 + 选项行起始消息索引 */
  private askHighlight = 0;
  private askSelected: boolean[] = [];
  private askOptionStart = -1;
  /** 回合 ask 块引用（块模式；无回合时走旧静态行兜底） */
  private askBlock: AskBlock | null = null;
  /** 当前回合（Sprint 45：一次用户输入 → agent 输出的结构化视图） */
  private currentTurn: TurnView | null = null;
  /** 折叠键提示已展示（当前回合首个可折叠块出现时） */
  private foldHintShown = false;
  /** 空闲期浏览模式（回看历史折叠；Esc/字母退出） */
  private browseMode = false;
  /** 浏览焦点：全局可折叠块列表下标（见 MessageList.foldableBlocks） */
  private browseFocus = -1;

  /** Sprint 45：回合开始。用户提问行已由 enter 路径入静态历史，回合从 assistant 侧开始 */
  startTurn(): TurnView {
    // 防御：上次回合未定稿（异常路径遗漏）→ 先定稿
    if (this.currentTurn) this.finishTurn("", { interrupted: true });
    const view = new TurnView();
    view.start();
    this.messages.appendTurn(view);
    this.currentTurn = view;
    this.foldHintShown = false;
    this.browseMode = false;
    this.browseFocus = -1;
    this.requestRender();
    return view;
  }

  /** Sprint 45：回合定稿（正常/中断）。结构保留供历史回看；meta 并入回合尾 */
  finishTurn(metaText = "", opts?: { interrupted?: boolean }): void {
    const view = this.currentTurn;
    if (!view) return;
    const interrupted = opts?.interrupted ?? false;
    view.textCommit();
    view.finish(metaText === "" && interrupted ? "（已中断）" : metaText, interrupted);
    this.currentTurn = null;
    this.foldHintShown = false;
    this.browseMode = false;
    this.browseFocus = -1;
    this.requestRender();
  }

  currentTurnView(): TurnView | null {
    return this.currentTurn;
  }

  /** 回合首块折叠键提示（index 在首个 thinking/tool 事件时调用一次） */
  maybeHintFoldKeys(): void {
    const view = this.currentTurn;
    if (!view || this.foldHintShown) return;
    this.foldHintShown = true;
    view.addNote(chalk.dim("  t/o 折叠思考与工具详情 · [ ] 切换焦点 · c/e 全收/全展"));
  }

  /** 写消息区统一收口（Sprint 45）：running 回合期间外部输出重定向进回合 raw 区，保屏幕底部顺序=到达序 */
  private appendToViewport(text: string): void {
    if (this.currentTurn?.isRunning()) {
      this.currentTurn.addRaw(text);
      return;
    }
    this.messages.append(text);
  }

  init(): void {
    if (this.active) return;
    this.active = true;

    // 保存真实 write，注入 Screen，避免捕获递归
    const origWrite = process.stdout.write.bind(process.stdout);
    this.realWrite = (s) => origWrite(s);
    this.screen.setOut((s) => this.realWrite?.(s));

    this.screen.init();

    // 接管 stdout.write：外部内容（index.ts 命令输出等）进入消息区
    this.capturedWrite = origWrite;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      this.bufferStdout(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    // 输入监听（非 TTY 环境降级，仅禁用输入）
    try {
      this.terminal.start(
        (ev) => this.handleKey(ev),
        () => this.onResize(),
        (s) => this.realWrite?.(s),
      );
    } catch {
      // raw mode 不可用（如管道/测试环境），跳过输入监听
    }

    // 进程退出恢复终端
    this.exitHandler = () => {
      this.screen.destroy();
      if (this.capturedWrite) {
        process.stdout.write = this.capturedWrite;
      }
    };
    process.on("exit", this.exitHandler);

    this.requestRender();
  }

  destroy(): void {
    if (!this.active) return;
    this.active = false;
    this.terminal.stop();
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = null;
    }
    if (this.capturedWrite) {
      process.stdout.write = this.capturedWrite;
      this.capturedWrite = null;
    }
    this.screen.destroy();
  }

  isActive(): boolean {
    return this.active;
  }

  /** 外部 stdout 内容 → 消息区（running 回合期间经收口进回合 raw 区） */
  private bufferStdout(text: string): void {
    if (!this.active) return;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      if (isLast) {
        if (lines[i]) this.appendToViewport(lines[i]);
      } else {
        this.appendToViewport(lines[i]);
      }
    }
    this.requestRender();
  }

  // ── 渲染 ──

  requestRender(): void {
    if (this.renderPending || !this.active) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.renderNow();
    }, 16);
  }

  renderNow(): void {
    if (!this.active) return;
    const rows = this.screen.getRows();
    const cols = this.screen.getCols();
    if (rows < 4) {
      // 终端太矮：仅显示状态栏
      this.screen.render([this.status.render(cols)[0]!]);
      return;
    }
    // 布局：消息区 + [hint] + 分隔线 + 输入区（动态多行）+ 状态栏
    const hintActive = this.completionHints.length > 0;
    const inputLines = this.input.render(cols);
    this.inputHeight = inputLines.length;
    const fixedRows = 2 + this.inputHeight + (hintActive ? 1 : 0); // 分隔线 + 输入区 + 状态栏 [+ hint]
    const contentHeight = rows - fixedRows;
    const msgLines = this.messages.renderViewport(cols, contentHeight);
    const hintLines = hintActive ? [this.renderHints(cols)] : [];
    const dividerLines = [this.renderDivider(cols)];
    const statusLines = this.status.render(cols);
    this.screen.render([...msgLines, ...hintLines, ...dividerLines, ...inputLines, ...statusLines]);
    // 光标：agent 运行期间隐藏（ask 等待回答除外）；prompt/ask 期间显示在输入区当前行
    // positionCursor 用 1 基行号：inputStart(0 基) + 1 换算
    const statusRow = rows - 1;
    const inputStart = statusRow - this.inputHeight;
    const cursorRow = inputStart + 1 + this.input.cursorRowInWindow();
    const cursorCol = this.input.cursorCol() + 1;
    if (this.agentRunning && !this.askPending) {
      this.screen.hideCursor();
    } else {
      this.screen.positionCursor(cursorRow, cursorCol);
      this.screen.showCursor();
    }
  }

  /** 渲染消息区与输入行之间的分隔线 */
  private renderDivider(cols: number): string {
    const fill = "─".repeat(Math.max(1, cols - 2));
    return chalk.dim(` ${fill} `);
  }

  /** 渲染补全候选提示行（截断防超宽） */
  private renderHints(cols: number): string {
    const text = this.completionHints.join("  ");
    const max = Math.min(cols, text.length);
    const line = text.slice(0, max);
    return `${chalk.dim("▸")} ${line}`;
  }

  /** 当前消息区可视高度（分隔线/输入区/状态栏固定，输入区按当前可视行数计，含提示行占用） */
  private messageViewport(): number {
    return Math.max(1, this.screen.getRows() - 2 - this.inputHeight - (this.completionHints.length > 0 ? 1 : 0));
  }

  private onResize(): void {
    this.screen.resize();
    this.requestRender();
  }

  // ── 消息 ──

  appendMessage(line: string): void {
    this.appendToViewport(line);
    this.requestRender();
  }

  appendMessages(lines: string[]): void {
    for (const l of lines) this.appendMessage(l);
  }

  /** 流式增量：设置半行（回合注入场景由 output 直接写 turn，此路径为未注入回退/防御） */
  setPartial(text: string): void {
    if (this.currentTurn?.isRunning()) {
      this.currentTurn.textPartial(text);
    } else {
      this.messages.setPartial(text);
    }
    this.requestRender();
  }

  /** 内联追加到当前最后一行（未注入回退；running 回合期间进回合 raw 区，防思考/文本混行） */
  appendInline(text: string): void {
    if (this.currentTurn?.isRunning()) {
      this.currentTurn.addRaw(text);
    } else {
      this.messages.appendInline(text);
    }
    this.requestRender();
  }

  // ── 状态栏 ──

  setStatus(data: StatusData): void {
    this.status.setData(data);
    this.requestRender();
  }

  // ── 输入 ──

  /** 阻塞等待一行输入（raw-mode） */
  prompt(): Promise<string> {
    if (!this.active) return Promise.resolve("");
    this.promptActive = true;
    this.input.setPrefix("你> ");
    this.input.setDisabled(false);
    this.requestRender();
    return new Promise<string>((resolve) => {
      this.promptResolve = resolve;
    });
  }

  /** Agent 运行期间：禁用输入，状态栏显示"思考中" */
  startAgentSession(): void {
    this.agentRunning = true;
    this.input.setDisabled(true);
    this.input.clear();
    this.completionHints = [];
    this.requestRender();
  }

  /** Agent 结束：恢复输入，清除瞬时状态（思考中/工具名） */
  endAgentSession(): void {
    this.agentRunning = false;
    this.input.setDisabled(false);
    this.status.clearTransient();
    // 回答结束后追加空行，分隔下一轮对话
    this.messages.append("");
    this.requestRender();
  }

  isAgentRunning(): boolean {
    return this.agentRunning;
  }

  /** 设置 Ctrl+C 中断回调（agent 运行期间连按） */
  setOnInterrupt(fn: (() => void) | null): void {
    this.onInterrupt = fn;
  }

  // ── ask_user 提问（TUI 输入行交互） ──

  /**
   * 发起提问（ask_user 工具）：渲染问题/选项到消息区，输入行前缀「答> 」，Enter 提交
   * 输入序号自动解析为对应选项文本；multiple 时支持逗号/空格分隔的多序号（如 1,3，结果以 ", " 连接）；
   * 超时（默认 30s）或 Ctrl+C 取消返回 null
   */
  ask(question: string, options: string[], timeoutMs = 30000, multiple = false): Promise<string | null> {
    // 上次提问未决：先取消
    if (this.askPending) this.resolveAsk(null, "canceled");

    this.askOptions = options;
    this.askMultiple = multiple;
    this.askSelected = options.map(() => false);
    this.askHighlight = 0;

    // 回合块模式：渲染交给 turn ask 块（高亮/勾选经 askUpdate 同步）；无回合（防御）走旧静态行兜底
    if (this.currentTurn?.isRunning()) {
      this.askBlock = this.currentTurn.addAsk(question, options, multiple);
      this.askOptionStart = -1;
    } else {
      this.askBlock = null;
      const startIdx = this.messages.getTotalLines();
      this.askOptionStart = startIdx + 2; // 空行(0) + 问题行(1) 之后是选项行
      this.messages.append("");
      this.messages.append(`${chalk.cyan("❓")} ${question}`);
      options.forEach((_, i) => {
        this.messages.append(this.askOptionLine(i));
      });
      let hint: string;
      if (multiple && options.length > 0) {
        hint = "（可多选：↑/↓ 移动，Tab/空格 勾选/取消，Enter 提交；也可输入序号如 1,3）";
      } else if (options.length > 0) {
        hint = "（↑/↓ 选择，Enter 提交；也可输入序号或自由文本）";
      } else {
        hint = "（输入回答后回车）";
      }
      this.messages.append(chalk.dim(hint));
    }

    this.input.setPrefix("答> ");
    this.input.setDisabled(false);
    this.input.clear();
    this.askPending = true;
    // 直接更新状态栏：实时定时器在首个工具调用时已停止（onToolCall 内 stopLiveStatus），
    // 不能依赖定时器轮询 isAskWaiting()
    this.status.setData({ ...this.status.getData(), status: "等待你的回答" });
    this.requestRender();

    return new Promise<string | null>((resolve) => {
      this.askResolve = resolve;
      this.askTimer = setTimeout(() => this.resolveAsk(null, "timeout"), timeoutMs);
    });
  }

  /** 构建选项行（勾选标记 + 高亮光标；单选仅显示光标） */
  private askOptionLine(i: number): string {
    const cursor = i === this.askHighlight ? ">" : " ";
    let line: string;
    if (this.askMultiple) {
      const marker = this.askSelected[i] ? "[*]" : "[ ]";
      line = `  ${cursor}${marker} ${i + 1}) ${this.askOptions[i]}`;
    } else {
      line = `  ${cursor} ${i + 1}) ${this.askOptions[i]}`;
    }
    if (i === this.askHighlight) return chalk.cyan(line);
    return this.askMultiple && this.askSelected[i] ? chalk.green(line) : chalk.dim(line);
  }

  /** 行模式：按行号重绘选项（无回合兜底路径） */
  private renderAskOptions(): void {
    if (this.askOptionStart < 0) return;
    this.askOptions.forEach((_, i) => {
      this.messages.setLine(this.askOptionStart + i, this.askOptionLine(i));
    });
    this.requestRender();
  }

  /** 重绘选项（块模式同步 turn ask 块；行模式按行号 setLine） */
  private syncAskRender(): void {
    if (this.askBlock && this.currentTurn) {
      this.currentTurn.askUpdate({ highlight: this.askHighlight, selected: this.askSelected });
    } else {
      this.renderAskOptions();
    }
    this.requestRender();
  }

  /** 结算提问：复位输入态、回合 ask 块置终态并 resolve */
  private resolveAsk(value: string | null, by: "answered" | "timeout" | "canceled" = "answered"): void {
    if (!this.askPending) return;
    this.askPending = false;
    if (this.askTimer) {
      clearTimeout(this.askTimer);
      this.askTimer = null;
    }
    if (this.askBlock && this.currentTurn) {
      this.currentTurn.finishAsk(value, by);
    }
    this.askBlock = null;
    this.input.clear();
    this.input.setDisabled(true);
    this.input.setPrefix("你> ");
    this.askOptions = [];
    this.askMultiple = false;
    this.askSelected = [];
    this.askHighlight = 0;
    this.askOptionStart = -1;
    const resolve = this.askResolve;
    this.askResolve = null;
    // 恢复"思考中"（agent 仍在运行；定时器若已恢复会继续接管）
    this.status.setData({ ...this.status.getData(), status: "思考中" });
    this.requestRender();
    resolve?.(value);
  }

  /** ask 等待回答期间的按键处理 */
  private handleAskKey(ev: KeyEvent): void {
    switch (ev.type) {
      case "char":
        // 多选模式：输入框为空时空格 = 勾选/取消当前高亮项（与 Tab 一致）；
        // 一旦开始输入（序号列表/自由文本），空格照常插入
        if (ev.char === " " && this.askMultiple && this.askOptions.length > 0 && this.input.getValue() === "") {
          this.askSelected[this.askHighlight] = !this.askSelected[this.askHighlight];
          this.syncAskRender();
          return;
        }
        this.input.type(ev.char);
        break;
      case "paste":
        for (const ch of ev.text) this.input.type(ch);
        break;
      case "enter": {
        const value = this.input.getValue().trim();
        if (value) {
          this.resolveAsk(parseOptionInput(value, this.askOptions, this.askMultiple));
          return;
        }
        // 多选：提交 Tab/空格 勾选的选项
        if (this.askMultiple && this.askSelected.some(Boolean)) {
          const picked = this.askSelected
            .map((sel, i) => (sel ? this.askOptions[i] : null))
            .filter((x): x is string => x !== null);
          this.resolveAsk(picked.join(", "));
          return;
        }
        // 单选：空输入 → 提交高亮项
        if (!this.askMultiple && this.askOptions.length > 0) {
          this.resolveAsk(this.askOptions[this.askHighlight]!);
          return;
        }
        return; // 空输入且无选中 → 忽略
      }
      case "backspace":
        this.input.backspace();
        break;
      case "delete":
        this.input.deleteChar();
        break;
      case "left":
        this.input.moveLeft();
        break;
      case "right":
        this.input.moveRight();
        break;
      case "home":
        this.input.moveHome();
        break;
      case "end":
        this.input.moveEnd();
        break;
      case "up":
        if (this.askOptions.length > 0) {
          this.askHighlight = Math.max(0, this.askHighlight - 1);
          this.syncAskRender();
        }
        return;
      case "down":
        if (this.askOptions.length > 0) {
          this.askHighlight = Math.min(this.askOptions.length - 1, this.askHighlight + 1);
          this.syncAskRender();
        }
        return;
      case "tab":
        if (this.askMultiple && this.askOptions.length > 0) {
          this.askSelected[this.askHighlight] = !this.askSelected[this.askHighlight];
          this.syncAskRender();
        }
        return;
      case "ctrlC":
      case "ctrlD":
        this.resolveAsk(null, "canceled"); // 取消提问
        return;
      default:
        return; // altEnter 等忽略（答案保持单行）
    }
    this.requestRender();
  }

  // ── Sprint 45：回合折叠键 ──

  /** 运行期折叠键（t/o/c/e/[/]）；返回是否已消费 */
  private handleAgentFoldKey(ch: string): boolean {
    const v = this.currentTurn;
    if (!v) return false;
    switch (ch) {
      case "t":
        v.toggleThinking();
        break;
      case "o":
        v.toggleToolDetail();
        break;
      case "[":
        v.moveFocus(-1);
        break;
      case "]":
        v.moveFocus(1);
        break;
      case "c":
        v.collapseAll();
        break;
      case "e":
        v.expandAll();
        break;
      default:
        return false;
    }
    this.requestRender();
    return true;
  }

  /** 空闲期进入浏览模式（回看历史折叠；Esc/字母退出） */
  private enterBrowse(): void {
    this.browseMode = true;
    this.browseFocus = -1;
    this.setBrowseStatus(true);
    this.requestRender();
  }

  private exitBrowse(): void {
    if (!this.browseMode) return;
    this.browseMode = false;
    this.browseFocus = -1;
    // 清除全部回合焦点高亮
    for (const b of this.messages.foldableBlocks()) b.view.focusId = null;
    this.setBrowseStatus(false);
    this.requestRender();
  }

  /** 浏览提示：状态栏 status 字段轮播（退出还原） */
  private setBrowseStatus(on: boolean): void {
    const cur = this.status.getData();
    if (on) {
      this.status.setData({ ...cur, status: "浏览：[/] 移动 · t/o 折叠 · 空格 切换 · c/e 全收展 · Esc 退出" });
    } else {
      this.status.setData({ ...cur, status: "" });
    }
  }

  /** 全局可折叠块（时间正序）焦点辅助 */
  private foldBlocks(): Array<{ view: TurnView; kind: "thinking" | "tool"; id: number }> {
    return this.messages.foldableBlocks();
  }

  /** 定位初始焦点：最近的 thinking（无则最近块） */
  private resolveBrowseFocus(): boolean {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return false;
    let idx = blocks.length - 1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.kind === "thinking") {
        idx = i;
        break;
      }
    }
    this.applyBrowseFocus(idx);
    return true;
  }

  /** 应用焦点：清全部高亮 → 目标块高亮 */
  private applyBrowseFocus(idx: number): void {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return;
    const n = blocks.length;
    const i = ((idx % n) + n) % n;
    this.browseFocus = i;
    for (const b of blocks) b.view.focusId = null;
    const target = blocks[i]!;
    target.view.focusId = target.id;
    this.requestRender();
  }

  private moveBrowseFocus(dir: -1 | 1): void {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return;
    const base = this.browseFocus < 0 ? blocks.length - 1 : this.browseFocus;
    this.applyBrowseFocus(base + dir);
  }

  /** t/o：跳到最近同类块并折叠/展开；焦点已是该类型则原地切换 */
  private browseToggleKind(kind: "thinking" | "tool"): void {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return;
    if (this.browseFocus >= 0 && blocks[this.browseFocus]!.kind === kind) {
      blocks[this.browseFocus]!.view.toggleById(blocks[this.browseFocus]!.id);
      this.requestRender();
      return;
    }
    // 从最近块向前找最近同类
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.kind === kind) {
        this.applyBrowseFocus(i);
        blocks[i]!.view.toggleById(blocks[i]!.id);
        this.requestRender();
        return;
      }
    }
  }

  private toggleBrowseFocusBlock(): void {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return;
    const idx = this.browseFocus < 0 ? blocks.length - 1 : this.browseFocus;
    const b = blocks[Math.min(idx, blocks.length - 1)]!;
    b.view.toggleById(b.id);
    this.requestRender();
  }

  private collapseExpandBrowseRound(open: boolean): void {
    const blocks = this.foldBlocks();
    if (blocks.length === 0) return;
    const idx = this.browseFocus < 0 ? blocks.length - 1 : Math.min(this.browseFocus, blocks.length - 1);
    const view = blocks[idx]!.view;
    if (open) view.expandAll();
    else view.collapseAll();
    this.requestRender();
  }

  /** 浏览模式键处理 */
  private handleBrowseKey(ev: KeyEvent): void {
    switch (ev.type) {
      case "up":
      case "wheelup":
      case "pageup":
        this.messages.scroll(ev.type === "pageup" ? 10 : 3, this.messageViewport());
        this.requestRender();
        return;
      case "down":
      case "wheeldown":
      case "pagedown":
        this.messages.scroll(ev.type === "pagedown" ? -10 : -3, this.messageViewport());
        this.requestRender();
        return;
      case "char":
        if (ev.char === "[") {
          this.moveBrowseFocus(-1);
          return;
        }
        if (ev.char === "]") {
          this.moveBrowseFocus(1);
          return;
        }
        if (ev.char === "t") {
          this.browseToggleKind("thinking");
          return;
        }
        if (ev.char === "o") {
          this.browseToggleKind("tool");
          return;
        }
        if (ev.char === " ") {
          this.toggleBrowseFocusBlock();
          return;
        }
        if (ev.char === "c") {
          this.collapseExpandBrowseRound(false);
          return;
        }
        if (ev.char === "e") {
          this.collapseExpandBrowseRound(true);
          return;
        }
        // 其余字符：退出浏览并输入
        this.exitBrowse();
        this.input.type(ev.char);
        this.requestRender();
        return;
      case "enter":
        this.toggleBrowseFocusBlock();
        return;
      case "escape":
        this.exitBrowse();
        return;
      case "paste":
        this.exitBrowse();
        for (const ch of ev.text) this.input.type(ch);
        this.requestRender();
        return;
      default:
        return;
    }
  }

  /** 测试/工具用：模拟注入键事件 */
  simulateKey(ev: KeyEvent): void {
    this.handleKey(ev);
  }

  // ── 键处理 ──

  private handleKey(ev: KeyEvent): void {
    // ask_user 等待回答：输入行编辑优先（agent 运行期间也响应）
    if (this.askPending) {
      this.handleAskKey(ev);
      return;
    }

    // 粘贴：插入文本
    if (ev.type === "paste") {
      if (this.promptActive && !this.agentRunning) {
        for (const ch of ev.text) this.input.type(ch);
        this.requestRender();
      }
      return;
    }

    if (this.agentRunning) {
      // 运行期间：折叠键（t/o/[/]/c/e）优先；滚轮/方向键滚动历史消息；Ctrl+C 中断
      if (ev.type === "char" && this.handleAgentFoldKey(ev.char)) return;
      if (ev.type === "up" || ev.type === "wheelup" || ev.type === "pageup") {
        this.messages.scroll(ev.type === "pageup" ? 10 : 3, this.messageViewport());
        this.requestRender();
        return;
      }
      if (ev.type === "down" || ev.type === "wheeldown" || ev.type === "pagedown") {
        this.messages.scroll(ev.type === "pagedown" ? -10 : -3, this.messageViewport());
        this.requestRender();
        return;
      }
      if (ev.type === "ctrlC") {
        this.onInterrupt?.();
      }
      return;
    }

    if (!this.promptActive) return;

    // 空闲期：浏览模式（回看历史折叠）
    if (this.browseMode) {
      this.handleBrowseKey(ev);
      return;
    }
    // 输入行为空且存在回合时，[ 进入浏览模式（非空输入时 [ 照常输入）
    if (ev.type === "char" && ev.char === "[" && this.input.getValue() === "" && this.messages.lastTurnView()) {
      this.enterBrowse();
      return;
    }

    switch (ev.type) {
      case "char":
        this.input.type(ev.char);
        this.completionHints = [];
        break;
      case "enter": {
        const value = this.input.getValue();
        this.promptActive = false;
        this.input.clear();
        this.completionHints = [];
        // 用户提问追加为消息（显示在对话历史中；多行输入去除首尾换行）
        if (value.trim()) {
          this.messages.append(`${this.input.getPrefix()}${value.trim()}`);
        }
        this.requestRender();
        const resolve = this.promptResolve;
        this.promptResolve = null;
        resolve?.(value);
        return;
      }
      case "altEnter":
        // Shift/Alt/Ctrl+Enter：插入换行（Enter 提交）
        this.input.type("\n");
        this.completionHints = [];
        break;
      case "backspace":
        this.input.backspace();
        this.completionHints = [];
        break;
      case "delete":
        this.input.deleteChar();
        this.completionHints = [];
        break;
      case "left":
        this.input.moveLeft();
        break;
      case "right":
        this.input.moveRight();
        break;
      case "home":
        this.input.moveHome();
        break;
      case "end":
        this.input.moveEnd();
        break;
      case "up":
        // 多行输入 → 光标上移一行；单行有内容 → 切历史；为空 → 滚动消息列表（滚轮亦然）
        if (this.input.isMultiLine()) {
          this.input.moveLineUp(this.screen.getCols());
        } else if (this.input.getValue()) {
          this.input.historyUp();
        } else {
          this.messages.scroll(3, this.messageViewport());
        }
        this.completionHints = [];
        break;
      case "down":
        if (this.input.isMultiLine()) {
          this.input.moveLineDown(this.screen.getCols());
        } else if (this.input.getValue()) {
          this.input.historyDown();
        } else {
          this.messages.scroll(-3, this.messageViewport());
        }
        this.completionHints = [];
        break;
      case "tab": {
        const candidates = this.input.complete();
        // 多候选时显示临时提示行（输入行上方，不写入消息历史）
        this.completionHints = candidates.length > 1 ? candidates : [];
        break;
      }
      case "wheelup":
      case "pageup":
        this.messages.scroll(ev.type === "pageup" ? 10 : 3, this.messageViewport());
        break;
      case "wheeldown":
      case "pagedown":
        this.messages.scroll(ev.type === "pagedown" ? -10 : -3, this.messageViewport());
        break;
      case "ctrlC":
      case "ctrlD":
        // 空闲时 Ctrl+C/Ctrl+D 退出（先恢复终端再退出）
        this.destroy();
        process.exit(0);
        return;
      default:
        return;
    }
    this.requestRender();
  }
}

export const tui = new Tui();
