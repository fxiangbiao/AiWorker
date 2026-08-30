<script lang="ts">
  import { onMount, tick } from "svelte";
  import { stream, setSending } from "$lib/stores/stream.svelte";
  import { ImagePlus } from "lucide-svelte";
  import { store, saveSettings, API } from "$lib/stores/chat.svelte";

  let text = $state("");
  let ta: HTMLTextAreaElement;
  let { onSend, inputMode, onSelectMode, onRetryLast, canRetry, onPickImage, imageCount = 0, agents = [] as { id: string; name: string }[] } = $props<{
    onSend: (msg: string) => void;
    inputMode: "chat" | "plan" | "debate" | "forge";
    onSelectMode: (m: "chat" | "plan" | "debate" | "forge") => void;
    onRetryLast?: () => void;
    canRetry?: boolean;
    /** 多模态图片：点击选择/粘贴（Sprint 36） */
    onPickImage?: () => void;
    imageCount?: number;
    agents?: { id: string; name: string }[];
  }>();

  const placeholders = {
    chat: "输入消息，Enter 发送...",
    plan: "描述任务，多专家协作执行（如：开发一款放置类手游）...",
    debate: "输入辩论话题，双专家分析（如：React vs Vue 技术选型）...",
    forge: "描述想要的应用，AI 即时生成（如：一个带番茄钟的 webapp）...",
  } as const;

  /** 任务类型下拉（对话/智能体协作/应用工坊；双专家辩论走 CLI /debate） */
  const TASK_TYPES = [
    { id: "chat", label: "对话" },
    { id: "plan", label: "智能体协作" },
    { id: "forge", label: "应用工坊" },
  ] as const;

  /** 权限模式（安全级别） */
  const MODES = [
    { id: "ask", label: "Ask", hint: "只读问答（不执行写操作）" },
    { id: "plan", label: "Plan", hint: "每步确认后执行" },
    { id: "auto", label: "Auto", hint: "自动执行（高危操作仍确认）" },
  ] as const;

  // ── 技能模式（Sprint 37）：输入 / 唤起技能选择器（检索 + 插入） ──
  interface SkillOption {
    name: string;
    description: string;
    expert: string;
    triggers: string[];
  }
  let skillOptions = $state<SkillOption[]>([]);
  let pickerOpen = $state(false);
  let pickerIdx = $state(0);
  /** 下拉展开方向：true=向上（输入区贴近视口底部时防被裁剪） */
  let pickerUp = $state(true);
  let pickerWrap: HTMLDivElement;

  onMount(() => {
    fetch(`${API}/skills`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        skillOptions = ((d.skills || []) as Record<string, unknown>[]).map((s) => ({
          name: (s.name as string) ?? "",
          description: (s.description as string) ?? "",
          expert: (s.expert as string) ?? "",
          triggers: ((s.triggers as string[]) ?? []) as string[],
        }));
      })
      .catch(() => {
        skillOptions = [];
      });
  });

  /** 输入中 "/" 后的 token（到首个空白为止） */
  let pickerToken = $derived(text.startsWith("/") ? (text.slice(1).match(/^[\w-]*/)?.[0] ?? "") : "");

  let filteredSkills = $derived.by(() => {
    if (!pickerOpen || inputMode !== "chat") return [];
    const q = pickerToken.toLowerCase();
    if (!q) return skillOptions;
    return skillOptions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.expert.toLowerCase().includes(q) ||
        s.triggers.some((t) => t.toLowerCase().includes(q)),
    );
  });

  /** 按输入区上下可用空间决定下拉方向（下方空间不足 280px 且上方更充裕时向上展开） */
  function positionPicker() {
    const rect = pickerWrap?.getBoundingClientRect();
    if (!rect) return;
    const roomBelow = window.innerHeight - rect.bottom;
    const roomAbove = rect.top;
    pickerUp = roomBelow < 280 && roomAbove > roomBelow;
  }

  function openPicker() {
    if (inputMode !== "chat") return;
    pickerOpen = true;
    pickerIdx = 0;
    tick().then(() => {
      positionPicker();
      ta?.focus();
    });
  }

  /** 插入技能名：保留已有草稿为任务（/token 之后的文本或纯文本草稿），避免误删输入内容 */
  function insertSkill(name: string) {
    let rest = "";
    if (text.trim().startsWith("/")) {
      const sp = text.indexOf(" ");
      rest = sp >= 0 ? text.slice(sp + 1).trim() : "";
    } else {
      rest = text.trim();
    }
    text = "/" + name + (rest ? " " + rest : " ");
    pickerIdx = 0;
    tick().then(() => {
      ta?.focus();
      const len = text.length;
      ta?.setSelectionRange(len, len);
      handleInput();
    });
  }

  function closePicker() {
    pickerOpen = false;
  }

  function selectMode(m: string) {
    store.mode = m;
    saveSettings();
  }
  function selectAgent(id: string) {
    store.agentId = id;
    saveSettings();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    // 技能选择器键盘导航：↑↓ 移动高亮，Tab 插入，Esc 关闭（Enter 始终直接发送）
    if (!pickerOpen || inputMode !== "chat") return;
    const n = filteredSkills.length;
    if (n === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerIdx = (pickerIdx + 1) % n;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pickerIdx = (pickerIdx - 1 + n) % n;
    } else if (e.key === "Tab") {
      e.preventDefault();
      insertSkill(filteredSkills[pickerIdx]!.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
    }
  }

  function handleInput() {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    // 技能选择器：chat 模式下输入以 "/" 开头即弹出
    if (inputMode === "chat" && text.startsWith("/")) {
      pickerOpen = true;
      pickerIdx = 0;
      positionPicker();
    } else {
      pickerOpen = false;
    }
  }

  function submit() {
    const val = text.trim();
    if (!val || stream.sending) return;
    text = "";
    pickerOpen = false;
    ta.style.height = "auto";
    onSend(val);
  }

  function stop() {
    stream.abortController?.abort();
    setSending(false, null);
  }
</script>

<div class="input-area">
  <div class="input-inner">
    <div class="input-row-wrap" bind:this={pickerWrap}>
      <div class="input-row">
        <textarea
          bind:this={ta}
          bind:value={text}
          rows="1"
          placeholder={stream.sending ? "AiWorker 正在处理..." : placeholders[inputMode]}
          disabled={stream.sending}
          onkeydown={handleKeydown}
          oninput={handleInput}
        ></textarea>
        {#if stream.sending}
          <button class="send-btn stop" onclick={stop} title="停止请求">&#9632;</button>
        {:else}
          {#if canRetry && onRetryLast}
            <button class="retry-btn" onclick={() => onRetryLast()} title="重新生成当前回复">&#8635;</button>
          {/if}
          <button class="send-btn" onclick={submit}>&#8593;</button>
        {/if}
      </div>

      {#if pickerOpen && inputMode === "chat"}
        <div class="skill-picker" class:up={pickerUp} class:down={!pickerUp}>
          {#if filteredSkills.length === 0}
            <div class="sp-empty-row">
              {skillOptions.length === 0 ? "暂无技能（检查 skills/ 目录或导入 .aw/.md）" : `无匹配技能 "${pickerToken}"`}
            </div>
          {:else}
            {#each filteredSkills as s, i (s.name)}
              <button
                class="sp-item"
                class:active={i === pickerIdx}
                onclick={() => insertSkill(s.name)}
                onmouseenter={() => (pickerIdx = i)}
                type="button"
              >
                <span class="sp-name">/ {s.name}</span>
                {#if s.expert}<span class="sp-expert">{s.expert}</span>{/if}
                {#if s.description}<span class="sp-desc">{s.description}</span>{/if}
              </button>
            {/each}
            <div class="sp-hint">Tab / 点击插入 · Enter 直接发送 · Esc 关闭</div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- 会话控制条（输入框下方）：左=输入相关，右=执行配置 -->
    <div class="config-bar">
      <div class="cfg-group">
        {#if onPickImage && inputMode !== "forge"}
          <button class="cfg-btn img-pill" title="添加图片（也可直接粘贴到输入框）" onclick={onPickImage}>
            <ImagePlus size={12} />
            图片{#if imageCount > 0}<span class="img-count">{imageCount}</span>{/if}
          </button>
        {/if}
        {#if inputMode === "chat"}
          <button class="cfg-btn img-pill" title="激活技能（输入 / 检索，如 /code-review）" onclick={openPicker}>
            &#9889; 技能
          </button>
        {/if}
        <select
          class="cfg-select"
          value={inputMode}
          title="任务类型"
          onchange={(e) => {
            onSelectMode((e.target as HTMLSelectElement).value as "chat" | "plan" | "forge");
            closePicker();
          }}
        >
          {#each TASK_TYPES as t (t.id)}
            <option value={t.id}>{t.label}</option>
          {/each}
        </select>
      </div>
      <div class="cfg-divider"></div>
      <div class="cfg-group">
        <select
          class="cfg-select"
          value={store.agentId}
          title="执行专家"
          onchange={(e) => selectAgent((e.target as HTMLSelectElement).value)}
        >
          {#each agents as a}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
        {#each MODES as m (m.id)}
          <button
            class="cfg-btn mode-pill"
            class:active={store.mode === m.id}
            title={m.hint}
            onclick={() => selectMode(m.id)}
          >
            {m.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .input-area { padding: 8px 0 16px; flex-shrink: 0; }
  .input-inner { width: 96%; max-width: 1400px; margin: 0 auto; padding: 0 24px; }
  .input-row-wrap { position: relative; }
  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    box-shadow: var(--shadow);
    transition: border-color .15s, box-shadow .15s;
  }
  .input-row:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(75, 117, 238, .1); }
  textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 14px;
    resize: none;
    outline: none;
    min-height: 24px;
    max-height: 120px;
    line-height: 1.6;
    padding: 0;
  }
  textarea::placeholder { color: var(--dim); }
  .send-btn {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--primary);
    color: #fff;
    border: none;
    font-size: 15px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all .15s;
    flex-shrink: 0;
  }
  .send-btn:hover { background: var(--primary-hover); }
  .send-btn:disabled { opacity: .3; cursor: default; }
  .send-btn.stop { background: var(--error); }
  .send-btn.stop:hover { background: var(--error); }
  .retry-btn {
    width: 34px; height: 34px;
    border-radius: 50%;
    background: transparent;
    color: var(--primary);
    border: 1px solid var(--border);
    font-size: 15px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: all .15s;
    flex-shrink: 0;
  }
  .retry-btn:hover { background: var(--hover-bg); border-color: var(--primary); }

  /* ── 会话控制条 ── */
  .config-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 4px 0;
    flex-wrap: wrap;
  }
  .cfg-group { display: flex; align-items: center; gap: 6px; }
  .cfg-divider { width: 1px; height: 18px; background: var(--border); }
  .cfg-btn, .cfg-select {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    color: var(--dim);
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all .15s;
  }
  .cfg-select { color: var(--text); outline: none; }
  .cfg-btn:hover:not(.active), .cfg-select:hover { border-color: var(--primary); color: var(--primary); }
  .cfg-select:focus { border-color: var(--primary); }
  .mode-pill.active { background: var(--primary); color: #fff; border-color: var(--primary); }
  .img-pill { display: flex; align-items: center; gap: 4px; }
  .img-count {
    font-size: 10px; font-weight: 600; color: var(--primary);
    background: var(--primary-light); border-radius: 8px; padding: 0 5px;
  }

  /* ── 技能选择器（Sprint 37） ── */
  .skill-picker {
    position: absolute;
    left: 0; right: 0;
    z-index: 30;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    max-height: 260px;
    overflow-y: auto;
    padding: 4px;
  }
  .skill-picker.up { bottom: calc(100% + 6px); }
  .skill-picker.down { top: calc(100% + 6px); }
  .sp-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background .12s;
  }
  .sp-item.active, .sp-item:hover { background: var(--hover-bg); }
  .sp-name { font-weight: 600; color: var(--primary); flex-shrink: 0; }
  .sp-expert {
    font-size: 10px; color: var(--dim); background: var(--hover-bg);
    border-radius: 8px; padding: 0 6px; flex-shrink: 0;
  }
  .sp-desc {
    color: var(--dim); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sp-empty-row { padding: 10px; font-size: 12px; color: var(--dim); text-align: center; }
  .sp-hint {
    padding: 6px 10px 4px;
    font-size: 10px;
    color: var(--dim);
    border-top: 1px solid var(--border);
    margin-top: 2px;
  }
</style>
