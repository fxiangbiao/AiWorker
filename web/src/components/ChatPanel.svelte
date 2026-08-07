<script lang="ts">
  import { tick } from "svelte";
  import UserMessage from "./UserMessage.svelte";
  import AgentCard from "./AgentCard.svelte";
  import ErrorBanner from "./ErrorBanner.svelte";
  import InputArea from "./InputArea.svelte";
  import {
    store,
    saveChats,
    saveMessages,
    loadMessages,
    type ChatItem,
    type UIMessage,
    type PlanStep,
    API,
  } from "$lib/stores/chat.svelte";
  import { stream, setSending } from "$lib/stores/stream.svelte";
  import { totalTokens, currentModel } from "$lib/stores/status";

  let errors: string[] = $state([]);

  let _lastMsgCount = $state(0);
  $effect(() => {
    const count = store.messages.length;
    if (count !== _lastMsgCount) {
      _lastMsgCount = count;
      tick().then(() => {
        const el = document.getElementById("msg-list");
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  });

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

    if (kind !== "chat") {
      if (!payload) {
        errors = [...errors, kind === "plan" ? "请输入任务描述" : "请输入辩论话题"];
        return;
      }
      handleCollab(kind, payload, text);
      return;
    }

    store.messages.push({ role: "user", content: text });

    const chat = store.chats.find((c) => c.id === store.activeChatId);
    if (chat && (!chat.turns || chat.turns === 0)) {
      chat.title = text.slice(0, 50);
      chat.turns = 1;
    } else if (chat) {
      chat.turns = (chat.turns || 0) + 1;
    }
    saveChats(store.chats);

    const ac = new AbortController();
    setSending(true, ac);
    errors = [];

    const agentMsg: UIMessage = { role: "assistant", agentId: store.agentId, content: "", timeline: [] };
    store.messages.push(agentMsg);

    fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        mode: store.mode,
        agentId: store.agentId,
        sessionId: store.activeChatId,
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
        }
      })
      .finally(() => {
        setSending(false, null);
        saveMessages(store.activeChatId!, store.messages);
      });
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
          args: data.args as string,
          id: data.id as string,
          result: false,
          pending: true,
        });
        agent._thinkingActive = true;
        break;
      case "tool_result": {
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
          totalTokens.set((data.tokenUsage as { total: number }).total || 0);
          currentModel.set((data.model as string) || "");
        }
        if (kind === "plan") {
          agent._meta = agent._meta || {};
          agent._meta.failedSteps = (data.failedSteps as string[]) || [];
        }
        agent._thinkingActive = false;
        agent._activeStep = undefined;
        if (data.content) agent.content = (data.content as string) || "";
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
      case "text":
        agent.content += (data.content as string) || "";
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
          args: data.args as string,
          id: data.id as string,
          result: false,
          pending: true,
        });
        break;
      case "tool_result": {
        for (let i = agent.timeline.length - 1; i >= 0; i--) {
          const t = agent.timeline[i];
          if (t.type === "tool" && !t.result) {
            t.result = true;
            t.resultPreview = data.summary as string;
            t.pending = false;
            if (!data.success) t.error = data.summary as string;
            break;
          }
        }
        break;
      }
      case "done":
        if (data.tokenUsage) {
          totalTokens.set((data.tokenUsage as { total: number }).total || 0);
          currentModel.set((data.model as string) || "");
        }
        break;
      case "error":
        errors = [...errors, (data.message as string) || "unknown error"];
        break;
    }
  }
</script>

<div class="main-panel">
  <div class="msg-list" id="msg-list">
    {#if store.messages.length === 0}
      <div class="empty-state">
        <div class="mark-big">&#9670;</div>
        <h2>AiWorker</h2>
        <p>个人 AI Agent 助手 &mdash; 多智能体协作 + 流式工具执行</p>
      </div>
    {:else}
      <div class="msg-inner">
      {#each store.messages as msg, i (i)}
        {#if msg.role === "user"}
          <UserMessage content={msg.content} />
        {:else if msg.role === "assistant" || msg.role === "agent"}
          <AgentCard {msg} />
        {/if}
      {/each}
      {#each errors as err}
        <ErrorBanner message={err} />
      {/each}
      </div>
    {/if}
  </div>
  <InputArea
    onSend={handleSend}
    inputMode={store.inputMode}
    onSelectMode={(m) => (store.inputMode = m)}
  />
</div>

<style>
  .main-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
  .msg-list {
    flex: 1;
    overflow-y: auto;
    scroll-behavior: smooth;
  }
  .msg-inner {
    width: 88%;
    max-width: 1200px;
    margin: 0 auto;
    padding: 24px 24px;
  }
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
</style>
