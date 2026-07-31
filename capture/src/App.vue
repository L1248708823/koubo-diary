<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";

type LocalConfig = {
  ingestUrl?: string;
  ingestToken?: string;
};

type CaptureEntry = {
  id: string;
  text: string;
  createdAt: string;
};

type DeliverPayload = {
  delivered?: boolean;
  error?: string;
  id?: string;
  message?: string;
};

type CaptureError = Error & {
  code?: "config" | "http";
};

declare global {
  interface Window {
    __KOUBO_LOCAL_CONFIG__?: LocalConfig;
  }
}

const prefix = "koubo-capture";
const localConfig = window.__KOUBO_LOCAL_CONFIG__ ?? {};
const draft = ref(localStorage.getItem(`${prefix}:draft`) || "");
const entries = ref<CaptureEntry[]>(readEntries());
const forceFailure = ref(false);
const sending = ref(false);
const lastResult = ref("等待投递");
const lastDeliveredText = ref("");
const undoVisible = ref(false);
const settingsOpen = ref(false);
const draftUrl = ref("");
const draftToken = ref("");
const ingestUrl = ref(
  localConfig.ingestUrl || localStorage.getItem(`${prefix}:ingestUrl`) || "",
);
const ingestToken = ref(
  localConfig.ingestToken || localStorage.getItem(`${prefix}:ingestToken`) || "",
);
const theme = ref(localStorage.getItem(`${prefix}:theme`) === "light" ? "light" : "dark");
const toastMessage = ref("");
const toastError = ref(false);
const toastVisible = ref(false);
const draftInput = ref<HTMLTextAreaElement | null>(null);

let toastTimer: number | undefined;
let undoTimer: number | undefined;

const submitDisabled = computed(
  () => draft.value.trim().length === 0 || sending.value,
);
const historySummary = computed(() =>
  entries.value.length ? `查看今日已投 ${entries.value.length} 条` : "今天还没有口播",
);
const reversedEntries = computed(() => entries.value.slice().reverse());
const stateOutput = computed(() =>
  JSON.stringify(
    {
      variant: "B · 在场感 · 真投递",
      draft: draft.value,
      todayEntries: entries.value.length,
      ingestUrlConfigured: Boolean(ingestUrl.value),
      tokenConfigured: Boolean(ingestToken.value),
      forceFailureNextSubmit: forceFailure.value,
      lastResult: lastResult.value,
      sending: sending.value,
    },
    null,
    2,
  ),
);

function todayKey(): string {
  return new Intl.DateTimeFormat("sv-SE").format(new Date());
}

function isCaptureEntry(value: unknown): value is CaptureEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<CaptureEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.text === "string" &&
    typeof entry.createdAt === "string"
  );
}

function readEntries(): CaptureEntry[] {
  const raw = localStorage.getItem(`${prefix}:entries:${todayKey()}`);
  if (!raw) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCaptureEntry) : [];
  } catch {
    return [];
  }
}

function saveEntries(): void {
  localStorage.setItem(
    `${prefix}:entries:${todayKey()}`,
    JSON.stringify(entries.value),
  );
}

function saveDraft(): void {
  localStorage.setItem(`${prefix}:draft`, draft.value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function showToast(message: string, error = false): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastMessage.value = message;
  toastError.value = error;
  toastVisible.value = true;
  toastTimer = window.setTimeout(() => {
    toastVisible.value = false;
  }, 2400);
}

function focusDraft(): void {
  void nextTick(() => draftInput.value?.focus());
}

function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem(`${prefix}:theme`, theme.value);
}

function openSettings(): void {
  draftUrl.value = ingestUrl.value;
  draftToken.value = ingestToken.value;
  settingsOpen.value = true;
  void nextTick(() => document.querySelector<HTMLInputElement>("#cfgUrl")?.focus());
}

function closeSettings(): void {
  settingsOpen.value = false;
  focusDraft();
}

function saveConfig(): void {
  ingestUrl.value = draftUrl.value.trim();
  ingestToken.value = draftToken.value.trim();
  localStorage.setItem(`${prefix}:ingestUrl`, ingestUrl.value);
  localStorage.setItem(`${prefix}:ingestToken`, ingestToken.value);
  lastResult.value = "设置已保存（仅本机）";
  closeSettings();
  showToast("设置已保存");
}

async function deliver(text: string): Promise<DeliverPayload> {
  if (!ingestUrl.value || !ingestToken.value) {
    const error = new Error("请先在设置里填写 Ingest URL 与 token") as CaptureError;
    error.code = "config";
    throw error;
  }

  const response = await fetch(ingestUrl.value, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken.value}`,
    },
    body: JSON.stringify({
      text,
      captured_at: new Date().toISOString(),
    }),
  });
  const payload = (await response.json().catch(() => null)) as DeliverPayload | null;

  if (!response.ok || !payload || payload.delivered !== true) {
    const message =
      payload?.error ||
      payload?.message ||
      `投递失败（HTTP ${response.status}）`;
    const error = new Error(message) as CaptureError;
    error.code = "http";
    throw error;
  }

  return payload;
}

async function send(): Promise<void> {
  if (sending.value) return;
  const text = draft.value.trim();
  if (!text) return;

  if (forceFailure.value) {
    forceFailure.value = false;
    lastResult.value = "失败：正文保留（强制）";
    showToast("暂时没送进去，正文还在", true);
    focusDraft();
    return;
  }

  sending.value = true;
  try {
    const payload = await deliver(text);
    const entry: CaptureEntry = {
      id: payload.id || crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    entries.value = [...entries.value, entry];
    saveEntries();
    lastDeliveredText.value = text;
    draft.value = "";
    saveDraft();
    lastResult.value = `成功：已投递 ${entry.id}（仅收件箱）`;
    showToast("已投递");
    undoVisible.value = true;
    if (undoTimer !== undefined) window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => {
      undoVisible.value = false;
    }, 5000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    lastResult.value = `失败：${message}`;
    showToast(message, true);
    if ((error as CaptureError).code === "config") openSettings();
  } finally {
    sending.value = false;
    focusDraft();
  }
}

function undoLast(): void {
  if (!lastDeliveredText.value) return;
  draft.value = lastDeliveredText.value;
  saveDraft();
  undoVisible.value = false;
  lastResult.value = "已回填正文（服务端条目仍在，可改完再投或等处理环）";
  showToast("正文已回填");
  focusDraft();
}

function clearLocal(): void {
  localStorage.removeItem(`${prefix}:draft`);
  Object.keys(localStorage)
    .filter((key) => key.startsWith(`${prefix}:entries:`))
    .forEach((key) => localStorage.removeItem(key));
  entries.value = [];
  draft.value = "";
  lastResult.value = "本地列表已清空";
  showToast("本地已清空");
  focusDraft();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && settingsOpen.value) closeSettings();
}

onMounted(() => {
  document.documentElement.dataset.theme = theme.value;
  window.addEventListener("keydown", handleKeydown);
  focusDraft();
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  if (undoTimer !== undefined) window.clearTimeout(undoTimer);
});
</script>

<template>
  <div class="shell">
    <header>
      <div class="brand">口播</div>
      <div class="header-actions">
        <button class="icon-btn" type="button" aria-label="投递设置" @click="openSettings">⚙</button>
        <button class="icon-btn" type="button" aria-label="切换主题" @click="toggleTheme">☼</button>
      </div>
    </header>

    <main>
      <div class="presence"><div><span>今日已投</span><strong>{{ entries.length }}</strong></div><span>条</span></div>
      <div class="capture-card">
        <textarea ref="draftInput" v-model="draft" autofocus placeholder="说就行…" aria-label="口播内容" @keydown.ctrl.enter="send" @keydown.meta.enter="send" />
      </div>
      <details class="history">
        <summary>{{ historySummary }}</summary>
        <ul class="history-list">
          <li v-for="entry in reversedEntries" :key="entry.id" class="history-item">
            <time>{{ formatTime(entry.createdAt) }}</time>
            {{ entry.text }}
          </li>
          <li v-if="entries.length === 0" class="history-item empty">送出后会显示在这里。</li>
        </ul>
      </details>
    </main>

    <details class="dev-tools">
      <summary>调试</summary>
      <div class="tools-body">
        <label>下次提交强制失败（不发请求） <input v-model="forceFailure" type="checkbox" /></label>
        <button type="button" @click="clearLocal">清空本地今日列表与草稿</button>
        <pre>{{ stateOutput }}</pre>
      </div>
    </details>
  </div>

  <div class="submit-bar"><button class="submit" type="button" :disabled="submitDisabled" @click="send">{{ sending ? "投递中…" : "送进收件箱" }}</button></div>
  <div v-if="undoVisible" class="undo"><span>已投递（服务端条目需在收件箱侧处理）</span><button type="button" @click="undoLast">正文回填</button></div>
  <div v-if="toastVisible" class="toast show" :class="{ error: toastError }" role="status" aria-live="polite">{{ toastMessage }}</div>

  <div v-if="settingsOpen" class="settings" role="dialog" aria-modal="true" aria-label="投递设置" @click.self="closeSettings">
    <form class="settings-panel" @submit.prevent="saveConfig">
      <h2>投递设置</h2>
      <p class="hint">URL 与 Bearer 只存在本机 localStorage，不进 git。投递成功只表示进入收件箱，不表示已整理进日记。</p>
      <label>Ingest URL<input id="cfgUrl" v-model="draftUrl" type="url" placeholder="https://vps.example/ingest" autocomplete="off" /></label>
      <label>Bearer token<input v-model="draftToken" type="password" placeholder="与 VPS INGEST_TOKEN 相同" autocomplete="off" /></label>
      <div class="settings-actions">
        <button type="button" @click="closeSettings">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>
  </div>
</template>
