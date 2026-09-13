<script lang="ts">
  import { tick, onMount } from "svelte";
  import UserMessage from "./UserMessage.svelte";
  import AgentCard from "./AgentCard.svelte";
  import ConfirmCard from "./ConfirmCard.svelte";
  import AskCard from "./AskCard.svelte";
  import ErrorBanner from "./ErrorBanner.svelte";
  import InputArea from "./InputArea.svelte";
  import GenCard from "./GenCard.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import { spawnGenCard } from "$lib/stores/apps.svelte";
  import type { ToolArtifact } from "$lib/artifacts";
  import {
    store,
    saveChats,
    saveMessages,
    loadRemoteMessages,
    type ChatItem,
    type UIMessage,
    type PlanStep,
    type ConfirmItem,
    type AskItem,
    toolArgsDisplay,
    API,
  } from "$lib/stores/chat.svelte";
  import { stream, setSending } from "$lib/stores/stream.svelte";
  import { totalTokens, promptTokens, completionTokens, currentModel } from "$lib/stores/status";

  let { agents = [] as { id: string; name: string }[] }: { agents?: { id: string; name: string }[] } = $props();

  let errors: string[] = $state([]);

  // ── 「从这里重新开始」（仅对话回滚；Sprint 50 从右栏回滚面板下移到对话流） ──
  interface ChatCheckpoint {
    turn: number;
    messageSeqBefore?: number;
  }
  let checkpoints = $state<ChatCheckpoint[]>([]);
  let checkpointSession = "";
  let rewindPending = $state<{ toTurn: number; messageCount: number } | null>(null);
  let rewindBusy = $state(false);
  let rewindError = $state("");

  /** 拉取检查点（按会话缓存；回滚后刷新） */
  async function loadCheckpoints(force = false): Promise<ChatCheckpoint[]> {
    const id = store.activeChatId ?? "";
    if (!id) return [];
    if (!force && checkpointSession === id) return checkpoints;
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/checkpoints`);
      if (!resp.ok) {
        checkpoints = [];
        return [];
      }
      const data = (await resp.json()) as { turns?: ChatCheckpoint[] };
      checkpoints = data.turns ?? [];
      checkpointSession = id;
    } catch {
      checkpoints = [];
    }
    return checkpoints;
  }

  /** 用户消息 seq → 所属回合（取"回合开始前消息 seq ≤ 本消息 seq"的最大回合） */
  function turnOfMessage(seq: number): number | null {
    let hit: number | null = null;
    for (const t of checkpoints) {
      if (typeof t.messageSeqBefore !== "number") continue;
      if (t.messageSeqBefore <= seq && (hit === null || t.turn > hit)) hit = t.turn;
    }
    return hit;
  }

  async function startChatRewind(index: number): Promise<void> {
    rewindError = "";
    const seq = store.messages[index]?.seq;
    if (seq === undefined) {
      rewindError = "这条消息没有服务端序号（本地新发的消息需刷新后可回滚）";
      return;
    }
    const turns = await loadCheckpoints();
    if (turns.length === 0) {
      rewindError = "本会话暂无检查点（检查点在每轮对话开始时创建，保留最近 20 轮）";
      return;
    }
    const turn = turnOfMessage(seq);
    if (turn === null) {
      rewindError = "找不到这条消息对应的检查点（可能已超出最近 20 轮）";
      return;
    }
    const id = store.activeChatId ?? "";
    rewindBusy = true;
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: turn, scope: "chat", dryRun: true }),
      });
      const data = (await resp.json()) as { plan?: { messageCount: number; blockers: string[] } };
      if (!resp.ok || !data.plan) {
        rewindError = `预览失败（${resp.status}）`;
        return;
      }
      if (data.plan.blockers.length > 0) {
        rewindError = data.plan.blockers[0]!;
        return;
      }
      rewindPending = { toTurn: turn, messageCount: data.plan.messageCount };
    } catch {
      rewindError = "无法连接服务端";
    } finally {
      rewindBusy = false;
    }
  }

  async function applyChatRewind(): Promise<void> {
    const target = rewindPending;
    rewindPending = null;
    const id = store.activeChatId ?? "";
    if (!target || !id) return;
    rewindBusy = true;
    try {
      const resp = await fetch(`${API}/sessions/${encodeURIComponent(id)}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toTurn: target.toTurn, scope: "chat" }),
      });
      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (!resp.ok || !data.ok) {
        rewindError = data.error ?? `回滚失败（${resp.status}）`;
        return;
      }
      saveMessages(id, []);
      const msgs = await loadRemoteMessages(id);
      if (store.activeChatId === id) {
        store.messages.length = 0;
        store.messages.push(...msgs);
      }
      await loadCheckpoints(true);
    } catch {
      rewindError = "无法连接服务端";
    } finally {
      rewindBusy = false;
    }
  }

  $effect(() => {
    void store.activeChatId;
    checkpointSession = "";
    rewindError = "";
    void loadCheckpoints();
  });

  // ── 多模态图片（Sprint 36）：待发送图片 data URL 列表（最多 4 张） ──
  let pendingImages = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement | null>(null);

  function addImages(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/") || pendingImages.length >= 4) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        if (url && pendingImages.length < 4) pendingImages = [...pendingImages, url];
      };
      reader.readAsDataURL(file);
    }
  }

  function onFilePick() {
    if (fileInput?.files) addImages(fileInput.files);
    if (fileInput) fileInput.value = "";
  }

  /** 粘贴图片（文本粘贴不受影响） */
  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (const it of items) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length > 0) {
      e.preventDefault();
      addImages(imgs);
    }
  }

  // 切换会话时清空错误提示与确认/提问卡片（临时状态）
  let _lastSession = $state(store.activeChatId);
  $effect(() => {
    if (store.activeChatId !== _lastSession) {
      _lastSession = store.activeChatId;
      errors = [];
      store.confirms = [];
      store.asks = [];
    }
  });

  // 自动滚动：消息条数或最后一条消息内容变化时，滚动到底部。
  // 流式输出是同一消息 content 增量（length 不变），必须同时监听内容长度；
  // 流式期间的实时滚动由 handleSSE 显式触发（scrollToBottom），此处为兜底。
  let _lastMsgCount = $state(0);
  let _lastContentLen = $state(0);
  $effect(() => {
    const count = store.messages.length;
    const last = store.messages.at(-1);
    const contentLen = last ? last.content.length : 0;
    if (count !== _lastMsgCount || contentLen !== _lastContentLen) {
      _lastMsgCount = count;
      _lastContentLen = contentLen;
      tick().then(() => scrollToBottom());
    }
  });

  /** 用户主动上翻标志：true 时流式跟随暂停（滚回底部或发送消息时恢复） */
  let userScrolledUp = false;

  onMount(() => {
    const el = document.getElementById("msg-list");
    if (!el) return;
    const onScroll = () => {
      userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  });

  function scrollToBottom(force = false) {
    const el = document.getElementById("msg-list");
    if (!el) return;
    // 用户主动上翻时暂停自动跟随；force=true 用于用户主动发送（明确要看新内容）
    if (userScrolledUp && !force) return;
    // 关闭 CSS smooth：程序化滚动用 instant，流式高频 delta 才不会互相打断
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prev;
  }

  function newChat() {
    setSending(false, null);
    const id = "c" + Date.now().toString(36);
    const chat: ChatItem = { id, title: "新对话", agentId: store.agentId, turns: 0, createdAt: Date.now() };
    store.chats.unshift(chat);
    store.activeChatId = id;
    store.messages.length = 0;
    errors = [];
    saveChats(store.chats);
  }


  function respondConfirm(id: string, value: string | null) {
    store.confirms = store.confirms.filter((c) => c.id !== id);
    fetch(`${API}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, value }),
    }).catch(() => { /* 服务端超时后忽略 */ });
  }

  function respondAsk(id: string, answer: string | null) {
    store.asks = store.asks.filter((a) => a.id !== id);
    fetch(`${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, answer }),
    }).catch(() => { /* 服务端超时后忽略 */ });
  }

  function handleSend(text: string) {
    if (stream.sending) return;
    if (!store.activeChatId) newChat();

    const kind = store.inputMode === "chat" && (text.startsWith("/plan ") || text.startsWith("/debate "))
      ? (text.startsWith("/plan ") ? "plan" : "debate")
      : store.inputMode === "chat"
        ? "chat"
        : store.inputMode;
    const payload = kind === "plan" && text.startsWith("/plan ") ? text.slice(6).trim()
      : kind === "debate" && text.startsWith("/debate ") ? text.slice(8).trim()
      : text;

    if (kind === "forge") {
      handleForge(payload, text);
      return;
    }

    if (kind !== "chat") {
      if (!payload) {
        errors = [...errors, kind === "plan" ? "请输入任务描述" : "请输入辩论话题"];
        return;
      }
      handleCollab(kind, payload, text);
      return;
    }

    store.messages.push({
      role: "user",
      content: text,
      images: pendingImages.length > 0 ? [...pendingImages] : undefined,
    });

    const chat = store.chats.find((c) => c.id === store.activeChatId);
    if (chat && (!chat.turns || chat.turns === 0)) {
      chat.title = text.slice(0, 50);
      chat.turns = 1;
    } else if (chat) {
      chat.turns = (chat.turns || 0) + 1;
    }
    saveChats(store.chats);

    const imgs = [...pendingImages];
    pendingImages = [];
    streamChat(text, imgs);
  }
  /** 统一发起 chat 流式请求（retryLast/streamChat/retryTool 共用） */
  function streamChatRequest(text: string, images: string[], onFail?: () => void) {
    const ac = new AbortController();
    setSending(true, ac);
    errors = [];

    const agentMsg: UIMessage = { role: "assistant", agentId: store.agentId, content: "", timeline: [] };
    store.messages.push(agentMsg);
    // 用户主动发送：强制滚动到底部（不受 nearBottom 限制）
    tick().then(() => scrollToBottom(true));

    fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        mode: store.mode,
        agentId: store.agentId,
        sessionId: store.activeChatId,
        images,
      }),
      signal: ac.signal,
    })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const reader = resp.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              handleSSE(JSON.parse(line.slice(6)));
            } catch {
              /* skip malformed SSE */
            }
          }
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          errors = [...errors, e.message];
          onFail?.();
        }
      })
      .finally(() => {
        setSending(false, null);
        saveMessages(store.activeChatId!, store.messages);
      });
  }

  function streamChat(text: string, images: string[] = []) {
    streamChatRequest(text, images);
  }

  /** 重新生成：重发最后一条用户消息，替换最后一条助手回复 */
  function retryLast() {
    if (stream.sending || store.inputMode !== "chat") return;
    let lastUserIdx = -1;
    for (let i = store.messages.length - 1; i >= 0; i--) {
      if (store.messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const text = store.messages[lastUserIdx].content;

    // 原地移除该用户消息之后的所有消息（保持 Svelte 5 响应式），旧回复暂存用于失败恢复
    const replaced = store.messages.splice(lastUserIdx + 1);
    store.messages = [...store.messages];

    streamChatRequest(text, [], () => {
      // 失败时恢复旧回复，避免消息丢失
      if (replaced.length > 0) {
        store.messages = [...store.messages, ...replaced];
      }
    });
  }

  /** 应用工坊：聊天流状态卡片 + 后台生成（生成期间不阻塞对话，可继续发消息） */
  function handleForge(payload: string, raw: string) {
    if (!payload) {
      errors = [...errors, "请输入要生成的应用描述"];
      return;
    }
    void spawnGenCard(payload, { sessionId: store.activeChatId ?? undefined, userText: raw });
  }

  async function handleCollab(kind: "plan" | "debate", payload: string, raw: string) {
    store.messages.push({ role: "user", content: raw });

    const chat = store.chats.find((c) => c.id === store.activeChatId);
    if (chat && (!chat.turns || chat.turns === 0)) {
      chat.title = raw.slice(0, 50);
      chat.turns = 1;
    } else if (chat) {
      chat.turns = (chat.turns || 0) + 1;
    }
    saveChats(store.chats);

    const ac = new AbortController();
    setSending(true, ac);
    errors = [];

    const agentMsg: UIMessage = {
      role: "assistant",
      agentId: kind === "plan" ? "team" : "debate",
      content: "",
      timeline: [],
      _kind: kind,
      _steps: [],
    };
    store.messages.push(agentMsg);
    // 用户主动发送：强制滚动到底部
    tick().then(() => scrollToBottom(true));

    try {
      const resp = await fetch(`${API}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "plan" ? { instruction: payload } : { topic: payload }),
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            handleCollabSSE(kind, JSON.parse(line.slice(6)));
          } catch {
            /* skip malformed SSE */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        errors = [...errors, (e as Error).message];
      }
    } finally {
      setSending(false, null);
      saveMessages(store.activeChatId!, store.messages);
    }
  }

  function handleCollabSSE(kind: "plan" | "debate", data: Record<string, unknown>) {
    const agent = store.messages.filter((x) => x.role === "assistant" || x.role === "agent").pop();
    if (!agent) return;

    switch (data.type) {
      case "plan": {
        const steps = (data.steps as PlanStep[]) || [];
        agent._steps = steps.map((s) => ({ ...s, status: "pending" as const }));
        agent._thinkingActive = true;
        break;
      }
      case "step_start": {
        const stepId = data.stepId as string;
        agent._thinkingActive = true;
        agent._activeStep = data.expertId as string;
        if (!agent._steps) return;
        for (const s of agent._steps) {
          s.status = s.id === stepId ? "running" : s.status;
        }
        break;
      }
      case "step_end": {
        const stepId = data.stepId as string;
        if (!agent._steps) return;
        for (const s of agent._steps) {
          if (s.id === stepId) {
            s.status = data.success ? "done" : "failed";
          }
        }
        break;
      }
      case "tool_call":
        if (kind === "debate") {
          agent._thinkingActive = true;
          agent._activeStep = `${data.name} · ${data.phase || data.args}`;
          break;
        }
        agent.timeline = agent.timeline || [];
        agent.timeline.push({
          type: "tool",
          name: data.name as string,
          args: toolArgsDisplay(data.name as string, data.args),
          id: data.id as string,
          result: false,
          pending: true,
        });
        agent._thinkingActive = true;
        break;
      case "tool_result": {
        if (data.name === "ask_user") store.asks = [];
        for (let i = (agent.timeline || []).length - 1; i >= 0; i--) {
          const t = agent.timeline![i];
          if (t.type === "tool" && !t.result) {
            t.result = !!data.success;
            t.pending = false;
            t.resultPreview = data.summary as string;
            if (!data.success) t.error = data.summary as string;
            break;
          }
        }
        break;
      }
      case "debate_start": {
        agent._meta = { agentA: data.agentA as string, agentB: data.agentB as string };
        agent._thinkingActive = true;
        break;
      }
      case "done": {
        if (data.tokenUsage) {
          const tu = data.tokenUsage as { total: number; prompt?: number; completion?: number };
          totalTokens.set(tu.total || 0);
          if (typeof tu.prompt === "number") promptTokens.set(tu.prompt);
          if (typeof tu.completion === "number") completionTokens.set(tu.completion);
          currentModel.set((data.model as string) || "");
        }
        if (kind === "plan") {
          agent._meta = agent._meta || {};
          agent._meta.failedSteps = (data.failedSteps as string[]) || [];
        }
        agent._thinkingActive = false;
        agent._activeStep = undefined;
        if (data.content) {
          agent.content = (data.content as string) || "";
          tick().then(() => scrollToBottom(true));
        }
        store.diffVersion++;
        break;
      }
      case "error":
        agent._thinkingActive = false;
        agent._activeStep = undefined;
        errors = [...errors, (data.message as string) || "unknown error"];
        break;
    }
  }

  function handleSSE(data: Record<string, unknown>) {
    const agent = store.messages.filter((x) => x.role === "assistant" || x.role === "agent").pop();
    if (!agent) return;
    agent.timeline = agent.timeline || [];

    switch (data.type) {
      case "skill_activated": {
        // 技能模式：/技能名 激活成功 → 助手消息顶部徽标
        const skill = { name: data.name as string, description: (data.description as string) || undefined };
        agent._skills = [...(agent._skills || []), skill];
        break;
      }
      case "skill_not_found": {
        // 移除刚推入的空助手消息，仅保留错误提示
        const last = store.messages[store.messages.length - 1];
        if (
          last &&
          (last.role === "assistant" || last.role === "agent") &&
          !last.content &&
          (!last.timeline || last.timeline.length === 0)
        ) {
          store.messages = store.messages.slice(0, -1);
        }
        const available = ((data.available as string[]) || []).join(", ");
        errors = [...errors, `未找到技能 "${data.name as string}"${available ? `。可用技能: ${available}` : ""}`];
        break;
      }
      case "text":
        agent.content += (data.content as string) || "";
        // 流式输出：显式跟随滚动（不依赖响应式 effect，保证每段 delta 都滚动）
        tick().then(() => scrollToBottom());
        break;
      case "thinking_start":
        agent._thinkingActive = true;
        break;
      case "thinking": {
        agent._thinkingActive = false;
        const last = agent.timeline[agent.timeline.length - 1];
        if (last && last.type === "thinking") {
          last.content += (data.content as string) || "";
        } else {
          agent.timeline.push({ type: "thinking", content: (data.content as string) || "", open: false });
        }
        break;
      }
      case "tool_call":
        agent.timeline.push({
          type: "tool",
          name: data.name as string,
          args: toolArgsDisplay(data.name as string, data.args),
          id: data.id as string,
          result: false,
          pending: true,
        });
        tick().then(() => scrollToBottom());
        break;
      case "tool_result": {
        // ask_user 已结算（回答/跳过/超时）→ 移除挂起的提问卡片
        if (data.name === "ask_user") store.asks = [];
        for (let i = agent.timeline.length - 1; i >= 0; i--) {
          const t = agent.timeline[i];
          if (t.type === "tool" && !t.result) {
            t.result = true;
            t.resultPreview = data.summary as string;
            t.pending = false;
            t.artifacts = (data.artifacts as ToolArtifact[] | undefined) ?? [];
            if (!data.success) t.error = data.summary as string;
            break;
          }
        }
        tick().then(() => scrollToBottom());
        break;
      }
      case "done":
        if (data.tokenUsage) {
          const tu = data.tokenUsage as { total: number; prompt?: number; completion?: number };
          totalTokens.set(tu.total || 0);
          if (typeof tu.prompt === "number") promptTokens.set(tu.prompt);
          if (typeof tu.completion === "number") completionTokens.set(tu.completion);
          currentModel.set((data.model as string) || "");
        }
        // 本轮用量（Sprint 44：/chat done 下发 turnUsage，写入当前助手消息气泡脚注）
        if (data.turnUsage) {
          const u = data.turnUsage as { prompt?: number; completion?: number; total?: number; contextPct?: number };
          agent._usage = {
            prompt: u.prompt ?? 0,
            completion: u.completion ?? 0,
            total: u.total ?? ((u.prompt ?? 0) + (u.completion ?? 0)),
            contextPct: u.contextPct ?? 0,
            perTurn: true,
          };
        }
        // 复位思考中状态
        for (const m of store.messages) {
          m._thinkingActive = false;
          m._activeStep = undefined;
        }
        store.confirms = [];
        store.asks = [];
        store.diffVersion++;
        tick().then(() => scrollToBottom(true));
        break;
      case "confirm_request": {
        const confirm: ConfirmItem = {
          id: data.confirmId as string,
          title: (data.title as string) || "操作确认",
          message: (data.message as string) || "",
          options: (data.options as { value: string; label: string }[]) || [
            { value: "allow", label: "允许" },
            { value: "deny", label: "拒绝" },
          ],
        };
        const exist = store.confirms.find((c) => c.id === confirm.id);
        if (!exist) store.confirms.push(confirm);
        break;
      }
      case "ask_user": {
        const ask: AskItem = {
          id: data.askId as string,
          question: (data.question as string) || "",
          options: ((data.options as string[]) || []).filter(Boolean),
          multiple: data.multiple === true,
        };
        const exist = store.asks.find((a) => a.id === ask.id);
        if (!exist) store.asks.push(ask);
        tick().then(() => scrollToBottom());
        break;
      }
      case "tool_blocked": {
        // 拦截提示已由 tool_result 写入工具卡片 error，此处仅标记卡片为错误样式，不再显示独立横幅
        const name = data.name as string;
        const msg = (data.message as string) || `${name} 被拦截`;
        for (const m of store.messages) {
          const tl = m.timeline || [];
          for (let i = tl.length - 1; i >= 0; i--) {
            const t = tl[i];
            if (t.type === "tool" && t.name === name && !t.error) {
              t.error = msg;
              t.result = true;
              t.pending = false;
              break;
            }
          }
        }
        break;
      }
      case "error":
        errors = [...errors, (data.message as string) || "unknown error"];
        for (const m of store.messages) {
          m._thinkingActive = false;
          m._activeStep = undefined;
        }
        store.confirms = [];
        store.asks = [];
        break;
    }
  }
  /** 工具重试：重发当前提问并附注"上次 X 工具失败，请重试"（始终走 chat 流） */
  function retryTool(tool: import("$lib/stores/chat.svelte").TimelineItem) {
    if (stream.sending) {
      errors = [...errors, "当前正在生成中，请稍候再重试"];
      return;
    }
    const lastUser = [...store.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const isBlocked = /拦截|禁止|不允许|高危|沙箱/.test(tool.error ?? "");
    const note = isBlocked
      ? `\n\n> ⚠️ 上次调用工具 \`${tool.name}\` 被系统拦截：${tool.error ?? ""}。请更换实现方式（如改用 fs_write 或调整命令），不要重复相同操作。`
      : `\n\n> ⚠️ 上次调用工具 \`${tool.name}\` 失败：${tool.error ?? ""}。请修正后重试。`;
    store.messages.push({ role: "user", content: `${lastUser.content}${note}` });
    const chat = store.chats.find((c) => c.id === store.activeChatId);
    if (chat) {
      chat.turns = (chat.turns || 0) + 1;
      saveChats(store.chats);
    }
    streamChat(`${lastUser.content}${note}`);
  }
</script>

<div class="main-panel" onpaste={handlePaste}>
  <div class="msg-list" id="msg-list">
    {#if store.messages.length === 0}
      <div class="empty-state">
        <div class="mark-big">&#9670;</div>
        <h2>AiWorker</h2>
        <p>个人 AI Agent 助手 &mdash; AI OS</p>
        <p class="empty-hint">在下方输入消息开始对话（支持粘贴图片）</p>
      </div>
    {:else}
      <div class="msg-inner">
      {#each store.messages as msg, i (i)}
        <div class="msg-anchor" id={`msg-${i}`}>
          {#if msg.role === "user"}
            <UserMessage content={msg.content} images={msg.images ?? []} />
            {#if msg.seq !== undefined}
              <button
                class="msg-rewind"
                title="回到这条消息之前（仅移除对话，不改动文件）"
                disabled={rewindBusy}
                onclick={() => void startChatRewind(i)}>从这里重新开始</button>
            {/if}
          {:else if msg.role === "assistant" || msg.role === "agent"}
            {#if msg._kind === "gen"}
              <GenCard {msg} />
            {:else}
              <AgentCard {msg} onRetryTool={retryTool} />
            {/if}
          {/if}
        </div>
      {/each}
      {#each store.confirms as c}
        <ConfirmCard confirm={c} onRespond={(v) => respondConfirm(c.id, v)} />
      {/each}
      {#each store.asks as a}
        <AskCard ask={a} onRespond={(v) => respondAsk(a.id, v)} />
      {/each}
      {#each errors as err}
        <ErrorBanner message={err} />
      {/each}
      {#if rewindError}
        <ErrorBanner message={rewindError} />
      {/if}
      </div>
    {/if}
  </div>
  {#if rewindPending}
    <ConfirmModal
      title="确认回滚对话"
      danger
      confirmText="移除对话"
      message={`回到第 ${rewindPending.toTurn} 轮之前，将移除 ${rewindPending.messageCount} 条消息（文件改动保留）。此操作不可撤销。`}
      onConfirm={() => void applyChatRewind()}
      onCancel={() => (rewindPending = null)}
    />
  {/if}
  {#if pendingImages.length > 0}
    <div class="img-bar">
      {#each pendingImages as url, i (i)}
        <div class="img-item">
          <img class="img-thumb" src={url} alt="待发送图片" />
          <button class="img-remove" title="移除" onclick={() => (pendingImages = pendingImages.filter((_, j) => j !== i))}>&#10005;</button>
        </div>
      {/each}
      <span class="img-hint">图片将随消息发送（需模型支持视觉）</span>
    </div>
  {/if}
  <input
    type="file"
    accept="image/*"
    multiple
    hidden
    bind:this={fileInput}
    onchange={onFilePick}
  />
  <InputArea
    onSend={handleSend}
    inputMode={store.inputMode}
    onSelectMode={(m) => (store.inputMode = m)}
    onRetryLast={retryLast}
    canRetry={!stream.sending && store.inputMode === "chat" && store.messages.length > 0 && (store.messages[store.messages.length - 1].role === "assistant" || store.messages[store.messages.length - 1].role === "agent")}
    onPickImage={() => fileInput?.click()}
    imageCount={pendingImages.length}
    {agents}
  />
</div>

<style>
  .main-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
  .img-bar { display: flex; align-items: center; gap: 10px; padding: 8px 18px 0; flex-wrap: wrap; }
  .img-item { position: relative; }
  .img-thumb { width: 72px; height: 72px; object-fit: cover; border-radius: var(--radius-sm); border: 1px solid var(--border); }
  .img-remove {
    position: absolute; top: -6px; right: -6px; width: 18px; height: 18px;
    border: none; border-radius: 50%; background: var(--error); color: #fff;
    font-size: 10px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .img-hint { font-size: 11px; color: var(--dim); }
  .msg-list {
    flex: 1;
    overflow-y: auto;
    scroll-behavior: smooth;
  }
  .msg-inner {
    width: 96%;
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 24px;
  }
  .msg-anchor { position: relative; }
  .msg-anchor .msg-rewind {
    position: absolute;
    right: 0;
    top: 2px;
    font-size: 10px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    color: var(--dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .msg-anchor:hover .msg-rewind { opacity: 1; }
  .msg-anchor .msg-rewind:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
  .msg-anchor .msg-rewind:disabled { opacity: 0.4; cursor: not-allowed; }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--dim);
    gap: 12px;
    text-align: center;
    padding: 24px 48px;
  }
  .mark-big { font-size: 40px; opacity: .15; }
  h2 { font-size: 18px; font-weight: 600; color: var(--text); }
  p { font-size: 13px; max-width: 340px; color: var(--dim); line-height: 1.6; }
  .empty-hint { font-size: 12px; color: var(--dim); opacity: .7; }
</style>
