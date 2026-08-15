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

  /** 外部 stdout 内容 → 消息区 */
  private bufferStdout(text: string): void {
    if (!this.active) return;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const isLast = i === lines.length - 1;
      if (isLast) {
        if (lines[i]) this.messages.append(lines[i]);
      } else {
        this.messages.append(lines[i]);
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
    this.messages.append(line);
    this.requestRender();
  }

  appendMessages(lines: string[]): void {
    this.messages.appendLines(lines);
    this.requestRender();
  }

  /** 流式增量：设置半行（TUI 模式由 output.ts 调用，替换上一半行） */
  setPartial(text: string): void {
    this.messages.setPartial(text);
    this.requestRender();
  }

  /** 内联追加到当前最后一行（思考流式等增量文本） */
  appendInline(text: string): void {
    this.messages.appendInline(text);
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
    if (this.askPending) this.resolveAsk(null);

    const startIdx = this.messages.getTotalLines();
    this.askOptions = options;
    this.askMultiple = multiple;
    this.askSelected = options.map(() => false);
    this.askHighlight = 0;
    this.askOptionStart = startIdx + 2; // 空行(0) + 问题行(1) 之后是选项行

    this.messages.append("");
    this.messages.append(`${chalk.cyan("❓")} ${question}`);
    options.forEach((_, i) => {
      this.messages.append(this.askOptionLine(i));
    });
    this.messages.append(
      chalk.dim(
        multiple && options.length > 0
          ? "（可多选：↑/↓ 移动，Tab 勾选/取消，Enter 提交；也可输入序号如 1,3）"
          : "（直接输入回答，或输入选项序号后回车）",
      ),
    );

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
      this.askTimer = setTimeout(() => this.resolveAsk(null), timeoutMs);
    });
  }

  /** 构建选项行（勾选标记 + 高亮光标） */
  private askOptionLine(i: number): string {
    const marker = this.askSelected[i] ? "[*]" : "[ ]";
    const cursor = i === this.askHighlight ? ">" : " ";
    const line = `  ${cursor}${marker} ${i + 1}) ${this.askOptions[i]}`;
    if (i === this.askHighlight) return chalk.cyan(line);
    return this.askSelected[i] ? chalk.green(line) : chalk.dim(line);
  }

  /** 重绘选项行（勾选/高亮变化后） */
  private renderAskOptions(): void {
    if (this.askOptionStart < 0) return;
    this.askOptions.forEach((_, i) => {
      this.messages.setLine(this.askOptionStart + i, this.askOptionLine(i));
    });
    this.requestRender();
  }

  /** 结算提问：复位输入态并 resolve */
  private resolveAsk(value: string | null): void {
    if (!this.askPending) return;
    this.askPending = false;
    if (this.askTimer) {
      clearTimeout(this.askTimer);
      this.askTimer = null;
    }
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
        // 输入为空：提交 Tab 勾选的选项
        if (this.askMultiple && this.askSelected.some(Boolean)) {
          const picked = this.askSelected
            .map((sel, i) => (sel ? this.askOptions[i] : null))
            .filter((x): x is string => x !== null);
          this.resolveAsk(picked.join(", "));
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
        if (this.askMultiple && this.askOptions.length > 0) {
          this.askHighlight = Math.max(0, this.askHighlight - 1);
          this.renderAskOptions();
          return;
        }
        return;
      case "down":
        if (this.askMultiple && this.askOptions.length > 0) {
          this.askHighlight = Math.min(this.askOptions.length - 1, this.askHighlight + 1);
          this.renderAskOptions();
          return;
        }
        return;
      case "tab":
        if (this.askMultiple && this.askOptions.length > 0) {
          this.askSelected[this.askHighlight] = !this.askSelected[this.askHighlight];
          this.renderAskOptions();
          return;
        }
        return;
      case "ctrlC":
      case "ctrlD":
        this.resolveAsk(null); // 取消提问
        return;
      default:
        return; // altEnter 等忽略（答案保持单行）
    }
    this.requestRender();
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
      // 运行期间：滚轮/方向键滚动历史消息；Ctrl+C 中断
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
