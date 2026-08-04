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
const lastResult = ref("还没开始记");
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
const theme = ref(localStorage.getItem(`${prefix}:theme`) === "dark" ? "dark" : "light");
const isDev = ref(typeof location !== "undefined" && new URLSearchParams(location.search).has("dev"));
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
  entries.value.length ? `今天记了 ${entries.value.length} 条` : "今天还没记过",
);
const reversedEntries = computed(() => entries.value.slice().reverse());
const stateOutput = computed(() =>
  JSON.stringify(
    {
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

function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme.value === "dark" ? "#191712" : "#f7f5f0");
}

function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  localStorage.setItem(`${prefix}:theme`, theme.value);
  applyTheme();
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
  lastResult.value = "设置已保存";
  closeSettings();
  showToast("设置已保存");
}

async function deliver(text: string): Promise<DeliverPayload> {
  if (!ingestUrl.value || !ingestToken.value) {
    const error = new Error("请先在设置里填好服务器地址和访问密钥") as CaptureError;
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
      `没记上（HTTP ${response.status}）`;
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
    lastResult.value = "已记下";
    showToast("记好了");
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
  lastResult.value = "正文已放回，改完再记一次就行";
  showToast("已撤销");
  focusDraft();
}

function clearLocal(): void {
  localStorage.removeItem(`${prefix}:draft`);
  Object.keys(localStorage)
    .filter((key) => key.startsWith(`${prefix}:entries:`))
    .forEach((key) => localStorage.removeItem(key));
  entries.value = [];
  draft.value = "";
  lastResult.value = "本地记录已清空";
  showToast("本地已清空");
  focusDraft();
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && settingsOpen.value) closeSettings();
}

onMounted(() => {
  applyTheme();
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
      <div class="brand">Yan帳</div>
      <div class="header-actions">
        <button class="icon-btn" type="button" aria-label="设置" @click="openSettings">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button class="icon-btn" type="button" :aria-label="theme === 'dark' ? '切到浅色' : '切到深色'" @click="toggleTheme">
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </button>
      </div>
    </header>

    <main>
      <div class="presence"><div><span>今天记了</span><strong>{{ entries.length }}</strong></div><span>条</span></div>
      <div class="capture-card">
        <textarea ref="draftInput" v-model="draft" autofocus placeholder="说就行…" aria-label="要说的话" @keydown.ctrl.enter="send" @keydown.meta.enter="send" />
      </div>
      <details class="history">
        <summary>{{ historySummary }}</summary>
        <ul class="history-list">
          <li v-for="entry in reversedEntries" :key="entry.id" class="history-item">
            <time>{{ formatTime(entry.createdAt) }}</time>
            {{ entry.text }}
          </li>
          <li v-if="entries.length === 0" class="history-item empty">记下的内容会显示在这里。</li>
        </ul>
      </details>
    </main>

    <details v-if="isDev" class="dev-tools">
      <summary>开发者选项</summary>
      <div class="tools-body">
        <label>下次提交强制失败（不发请求） <input v-model="forceFailure" type="checkbox" /></label>
        <button type="button" @click="clearLocal">清空本地今日列表与草稿</button>
        <pre>{{ stateOutput }}</pre>
      </div>
    </details>
  </div>

  <div class="submit-bar"><button class="submit" type="button" :disabled="submitDisabled" @click="send">{{ sending ? "记一下…" : "记下来" }}</button></div>
  <Transition name="undo">
    <div v-if="undoVisible" class="undo"><span>已记下，想改的话能改回来</span><button type="button" @click="undoLast">撤销</button></div>
  </Transition>
  <Transition name="toast">
    <div v-if="toastVisible" class="toast" :class="{ error: toastError }" role="status" aria-live="polite">{{ toastMessage }}</div>
  </Transition>

  <div v-if="settingsOpen" class="settings" role="dialog" aria-modal="true" aria-label="连接设置" @click.self="closeSettings">
    <form class="settings-panel" @submit.prevent="saveConfig">
      <h2>连接设置</h2>
      <p class="hint">填好服务器地址和访问密钥，口播才能存进你自己的日记。这些内容只保存在这台设备上，不会进代码仓库。</p>
      <label>服务器地址<input id="cfgUrl" v-model="draftUrl" type="url" placeholder="https://vps.example/ingest" autocomplete="off" /></label>
      <label>访问密钥<input v-model="draftToken" type="password" placeholder="填服务器给你的密钥" autocomplete="off" /></label>
      <div class="settings-actions">
        <button type="button" @click="closeSettings">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>
  </div>
</template>
