import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

type GenerationPayload = { jobId: string };

type Env = {
  GENERATION_WORKFLOW: Workflow<GenerationPayload>;
  SETUP_STATE: DurableObjectNamespace<SetupState>;
  SITE_BASE_URL: string;
};

type JobState = {
  id: string;
  status: string;
  progressText: string;
  updatedAt: string;
  terminal: boolean;
  retryAfterSeconds: number;
};

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETUP_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{12}$/;
const LINK_TOKEN_PATTERN = /^yume_cf_[A-Za-z0-9_-]{43}$/;
const MAX_ADVANCE_STEPS = 720;
const STATE_NAME = "owner-connection";

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function setupPage(configured: boolean) {
  const status = configured
    ? "このWorkerには接続設定があります。再接続する場合だけ、新しいコードを入力してください。"
    : "夢綴りの設定画面で発行した12文字の接続コードを入力してください。";
  const document = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>夢綴り × Cloudflare</title>
<style>:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}*{box-sizing:border-box}body{min-height:100svh;margin:0;display:grid;place-items:center;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom));color:#f7f3ff;background:#050506}main{width:min(100%,430px);padding:30px 24px;border:1px solid #29232f;border-radius:24px;background:linear-gradient(145deg,#17121d,#0d0d10);box-shadow:0 24px 80px #000}i{width:58px;height:58px;display:grid;place-items:center;margin:0 auto 18px;border-radius:18px;color:#d9b7ff;background:#23172e;font-size:28px;font-style:normal}h1{margin:0;text-align:center;font-family:"Yu Mincho",serif;font-size:25px}p{margin:12px 0 22px;color:#aaa4b2;font-size:14px;line-height:1.8}label{display:block;margin-bottom:8px;color:#d9d2df;font-size:13px;font-weight:700}input{width:100%;height:54px;border:1px solid #3b3244;border-radius:14px;padding:0 14px;outline:none;color:#fff;background:#0a0a0c;font:700 17px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}input:focus{border-color:#b87eff;box-shadow:0 0 0 3px #b87eff22}button{width:100%;min-height:52px;margin-top:12px;border:1px solid #9b5de0;border-radius:14px;color:#fff;background:#6e35a8;font-size:15px;font-weight:800}button:disabled{opacity:.55}#result{min-height:24px;margin:15px 0 0;color:#b9b2c2;font-size:13px}#result.ok{color:#82e0b5}#result.error{color:#ff9caa}small{display:block;margin-top:18px;color:#716b78;font-size:11px;line-height:1.7}</style></head>
<body><main><i>✦</i><h1>夢綴り × Cloudflare</h1><p>${status}</p><form id="pair"><label for="code">15分有効の接続コード</label><input id="code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="14" placeholder="ABCD-EFGH-JKLM" required><button id="submit" type="submit">夢綴りと接続</button></form><p id="result" role="status" aria-live="polite"></p><small>Cloudflare APIトークンやアカウントIDは夢綴りへ送信されません。接続専用の秘密鍵は、このWorker内で自動生成・保存されます。</small></main>
<script>const form=document.querySelector('#pair'),button=document.querySelector('#submit'),result=document.querySelector('#result'),input=document.querySelector('#code');input.addEventListener('input',()=>{const value=input.value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g,'').slice(0,12);input.value=value.replace(/(.{4})(?=.)/g,'$1-')});form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;button.textContent='接続しています…';result.className='';result.textContent='夢綴りへ安全に登録しています。';try{const response=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupCode:input.value})});const body=await response.json();if(!response.ok)throw new Error(body.error||'接続できませんでした。');result.className='ok';result.textContent='接続しました。夢綴りへ戻って「状態を確認」を押してください。';button.textContent='接続済み'}catch(error){result.className='error';result.textContent=error instanceof Error?error.message:'接続できませんでした。';button.disabled=false;button.textContent='もう一度試す'}});</script></body></html>`;

  return new Response(document, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  return /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? "";
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function authorized(request: Request, expected: string | null) {
  const provided = bearerToken(request);
  if (!expected || !provided || provided.length > 160) return false;
  const [left, right] = await Promise.all([digest(provided), digest(expected)]);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function createLinkToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `yume_cf_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}

function normalizeSetupCode(value: unknown) {
  return typeof value === "string" ? value.toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g, "") : "";
}

function siteBaseUrl(env: Env) {
  const value = new URL(env.SITE_BASE_URL);
  if (value.protocol !== "https:") throw new Error("SITE_BASE_URL must use HTTPS.");
  return value.origin;
}

function setupState(env: Env) {
  return env.SETUP_STATE.getByName(STATE_NAME);
}

function isJobState(value: unknown): value is JobState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string"
    && typeof row.status === "string"
    && typeof row.progressText === "string"
    && typeof row.updatedAt === "string"
    && typeof row.terminal === "boolean"
    && typeof row.retryAfterSeconds === "number";
}

async function registerPairing(request: Request, env: Env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) return json({ error: "このWorkerの画面から操作してください。" }, 403);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1024) return json({ error: "入力が長すぎます。" }, 413);
  const payload = await request.json().catch(() => null) as { setupCode?: unknown } | null;
  const setupCode = normalizeSetupCode(payload?.setupCode);
  if (!SETUP_CODE_PATTERN.test(setupCode)) return json({ error: "接続コードの形式が正しくありません。" }, 400);

  const state = setupState(env);
  const linkToken = createLinkToken();
  const previousToken = await state.replaceLinkToken(linkToken);
  try {
    const response = await fetch(`${siteBaseUrl(env)}/api/internal/orchestrator/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yume-Setup-Code": setupCode,
      },
      body: JSON.stringify({ workerUrl: requestUrl.origin, linkToken }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => null) as { error?: unknown } | null;
    if (!response.ok) {
      await state.restoreLinkToken(linkToken, previousToken);
      return json({ error: typeof result?.error === "string" ? result.error : "夢綴りへ登録できませんでした。接続コードを再発行してください。" }, response.status >= 500 ? 502 : response.status);
    }
    return json({ connected: true, workerHost: requestUrl.host });
  } catch (error) {
    await state.restoreLinkToken(linkToken, previousToken);
    console.error(JSON.stringify({ level: "error", event: "pairing_failed", error: error instanceof Error ? error.message : String(error) }));
    return json({ error: "夢綴りとの通信が完了しませんでした。少し待ってから再度お試しください。" }, 502);
  }
}

async function advanceSiteJob(env: Env, jobId: string): Promise<JobState> {
  const token = await setupState(env).getLinkToken();
  if (!token) throw new NonRetryableError("Dream app pairing is not configured.");
  const response = await fetch(`${siteBaseUrl(env)}/api/internal/orchestrator/jobs/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => null) as { job?: unknown; error?: unknown } | null;
  if (response.status === 400 || response.status === 401 || response.status === 404) {
    throw new NonRetryableError(typeof payload?.error === "string" ? payload.error : `Dream app rejected job ${jobId}.`);
  }
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `Dream app returned HTTP ${response.status}.`);
  if (!isJobState(payload?.job)) throw new Error("Dream app returned an invalid job state.");
  return payload.job;
}

export class SetupState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    });
  }

  getLinkToken(): string | null {
    return this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM secrets WHERE name = 'link_token'").toArray()[0]?.value ?? null;
  }

  replaceLinkToken(nextToken: string): string | null {
    if (!LINK_TOKEN_PATTERN.test(nextToken)) throw new Error("Invalid link token.");
    const previousToken = this.getLinkToken();
    this.ctx.storage.sql.exec("INSERT INTO secrets (name, value) VALUES ('link_token', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", nextToken);
    return previousToken;
  }

  restoreLinkToken(expectedToken: string, previousToken: string | null): boolean {
    if (this.getLinkToken() !== expectedToken) return false;
    if (previousToken && LINK_TOKEN_PATTERN.test(previousToken)) {
      this.ctx.storage.sql.exec("UPDATE secrets SET value = ? WHERE name = 'link_token'", previousToken);
    } else {
      this.ctx.storage.sql.exec("DELETE FROM secrets WHERE name = 'link_token'");
    }
    return true;
  }
}

export class GenerationWorkflow extends WorkflowEntrypoint<Env, GenerationPayload> {
  async run(event: WorkflowEvent<GenerationPayload>, step: WorkflowStep) {
    const jobId = event.payload?.jobId;
    if (!jobId || !JOB_ID_PATTERN.test(jobId)) throw new NonRetryableError("Invalid generation job ID.");

    for (let index = 0; index < MAX_ADVANCE_STEPS; index += 1) {
      const state = await step.do(
        `advance generation ${index + 1}`,
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          timeout: "30 minutes",
        },
        async () => advanceSiteJob(this.env, jobId),
      );
      if (state.terminal) return { jobId, status: state.status };
      const delay = Math.min(120, Math.max(2, Math.round(state.retryAfterSeconds || 3)));
      await step.sleep(`wait before advance ${index + 1}`, `${delay} seconds`);
    }

    throw new NonRetryableError(`Generation job ${jobId} exceeded the Workflow step budget.`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const state = setupState(env);

    if (request.method === "GET" && url.pathname === "/") return setupPage(Boolean(await state.getLinkToken()));
    if (request.method === "POST" && url.pathname === "/pair") return registerPairing(request, env);

    if (!await authorized(request, await state.getLinkToken())) return json({ error: "Unauthorized" }, 401);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "yume-tsuzuri-orchestrator", ready: true });
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > 4096) return json({ error: "Request too large" }, 413);
      const payload = await request.json().catch(() => null) as { jobId?: unknown } | null;
      const jobId = typeof payload?.jobId === "string" ? payload.jobId : "";
      if (!JOB_ID_PATTERN.test(jobId)) return json({ error: "Invalid job ID" }, 400);
      try {
        await env.GENERATION_WORKFLOW.create({
          id: jobId,
          params: { jobId },
          retention: { successRetention: "1 day", errorRetention: "3 days" },
        });
      } catch {
        await env.GENERATION_WORKFLOW.get(jobId);
      }
      return json({ accepted: true, jobId }, 202);
    }

    const jobMatch = /^\/jobs\/([0-9a-f-]+)$/i.exec(url.pathname);
    if (jobMatch && JOB_ID_PATTERN.test(jobMatch[1])) {
      try {
        const instance = await env.GENERATION_WORKFLOW.get(jobMatch[1]);
        if (request.method === "GET") return json({ jobId: jobMatch[1], workflow: await instance.status() });
        if (request.method === "DELETE") {
          const status = await instance.status();
          if (!["complete", "errored", "terminated"].includes(status.status)) await instance.terminate();
          return json({ stopped: true, jobId: jobMatch[1] });
        }
      } catch {
        return json({ error: "Workflow instance not found" }, 404);
      }
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
