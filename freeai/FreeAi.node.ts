import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeConnectionType } from "n8n-workflow";

type ProviderId = "ovh" | "llm7" | "openrouter";

const PROVIDERS: Record<
  ProviderId,
  { name: string; base: string; model: string; needsKey: boolean }
> = {
  ovh: {
    name: "OVHcloud (anonim, 2 RPM/IP)",
    base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    model: "gpt-oss-20b",
    needsKey: false,
  },
  llm7: {
    name: "LLM7.io (anonim)",
    base: "https://api.llm7.io/v1",
    model: "DeepSeek-V4-Flash-0731",
    needsKey: false,
  },
  openrouter: {
    name: "OpenRouter (butuh API key)",
    base: "https://openrouter.ai/api/v1",
    model: "openrouter/free",
    needsKey: true,
  },
};

const FAILOVER_ORDER: ProviderId[] = ["ovh", "llm7", "openrouter"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UpstreamResult {
  ok: boolean;
  provider: ProviderId | "";
  text: string;
  latencyMs: number;
  status: number;
  error?: string;
}

export class FreeAi implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Free AI (OVH / LLM7 / OpenRouter)",
    name: "freeAi",
    icon: "file:zernio-logo.svg",
    group: ["transform"],
    version: 1,
    description:
      "Generate text dengan provider AI free-tier: OVHcloud dan LLM7.io anonim tanpa API key, OpenRouter dengan key. Termasuk failover otomatis antar provider.",
    defaults: {
      name: "Free AI",
    },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main],

    credentials: [
      {
        name: "freeAiApi",
        required: false,
      },
    ],

    properties: [
      {
        displayName: "Provider",
        name: "provider",
        type: "options",
        default: "failover3",
        options: [
          {
            name: "Failover 3 (OVH → LLM7 → OpenRouter)",
            value: "failover3",
            description: "Coba tiap provider berurutan sampai ada yang sukses",
          },
          {
            name: "OVHcloud (anonim)",
            value: "ovh",
            description: "gpt-oss-20b, tanpa key, 2 request/menit per IP",
          },
          {
            name: "LLM7.io (anonim)",
            value: "llm7",
            description: "DeepSeek-V4-Flash, tanpa key",
          },
          {
            name: "OpenRouter (free pool)",
            value: "openrouter",
            description: "openrouter/free, butuh API key di kredensial",
          },
        ],
        description: "Provider free-tier yang dipakai",
      },
      {
        displayName: "Prompt",
        name: "prompt",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        placeholder: "Mis. Ringkas teks berikut...",
        description: "Perintah untuk model. Mendukung ekspresi n8n ({{ $json... }}).",
      },
      {
        displayName: "System Prompt",
        name: "system",
        type: "string",
        typeOptions: { rows: 3 },
        default: "",
        description: "Opsional: instruksi sistem",
      },
      {
        displayName: "Max Tokens",
        name: "maxTokens",
        type: "number",
        typeOptions: { minValue: 16, maxValue: 8192 },
        default: 512,
        description: "Budget token keluaran (model reasoning bisa menghabiskannya)",
      },
      {
        displayName: "Temperature",
        name: "temperature",
        type: "number",
        typeOptions: { minValue: 0, maxValue: 2, numberStepSize: 0.1 },
        default: 0.2,
      },
      {
        displayName: "Timeout (detik)",
        name: "timeout",
        type: "number",
        default: 30,
        description: "Batas waktu per request ke upstream",
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const providerChoice = this.getNodeParameter("provider", i) as string;
      const prompt = this.getNodeParameter("prompt", i) as string;
      const system = this.getNodeParameter("system", i, "") as string;
      const maxTokens = this.getNodeParameter("maxTokens", i, 512) as number;
      const temperature = this.getNodeParameter("temperature", i, 0.2) as number;
      const timeout = (this.getNodeParameter("timeout", i, 30) as number) * 1000;

      if (!prompt) {
        throw new Error("Prompt kosong");
      }

      let apiKey = "";
      try {
        const creds = await this.getCredentials("freeAiApi");
        apiKey = String(creds.apiKey ?? "");
      } catch {
        // kredensial opsional belum dibuat -> provider anonim tetap jalan
      }

      const order: ProviderId[] =
        providerChoice === "failover3"
          ? FAILOVER_ORDER
          : [providerChoice as ProviderId];

      const messages: { role: string; content: string }[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });

      const result = await callWithFailover(this, order, {
        messages,
        maxTokens,
        temperature,
        timeout,
        apiKey,
      });

      out.push({
        json: {
          ok: result.ok,
          provider: result.provider,
          text: result.text,
          latencyMs: result.latencyMs,
          status: result.status,
          error: result.error,
        } as INodeExecutionData["json"],
      });
    }

    return [out];
  }

}

async function callWithFailover(
  ctx: IExecuteFunctions,
  order: ProviderId[],
    req: {
      messages: { role: string; content: string }[];
      maxTokens: number;
      temperature: number;
      timeout: number;
      apiKey: string;
    },
  ): Promise<UpstreamResult> {
    const errors: string[] = [];

    for (const pid of order) {
      const p = PROVIDERS[pid];
      if (!p) continue;
      if (p.needsKey && !req.apiKey) {
        errors.push(`${pid}: butuh API key di kredensial Free AI`);
        continue;
      }

      let effMax = req.maxTokens;
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now();
        try {
          const body = await ctx.helpers.httpRequest({
            method: "POST",
            url: `${p.base}/chat/completions`,
            headers: {
              "Content-Type": "application/json",
              ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}),
            },
            body: {
              model: p.model,
              messages: req.messages,
              max_tokens: effMax,
              temperature: req.temperature,
            },
            json: true,
            timeout: req.timeout,
            returnFullResponse: false,
            skipSslCertificateValidation: false,
          });

          const choices = (body as { choices?: { message?: { content?: string } }[] })
            .choices;
          const text = (choices?.[0]?.message?.content ?? "").trim();
          if (text) {
            return {
              ok: true,
              provider: pid,
              text,
              latencyMs: Date.now() - started,
              status: 200,
            };
          }
          // jawaban kosong: model reasoning menghabiskan token -> budget lebih besar
          effMax = Math.max(effMax * 4, 512);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${pid}: ${message.slice(0, 120)}`);
          // 429 rate limit -> jeda lalu coba lagi sekali lagi
          if (/429|rate limit/i.test(message)) {
            await sleep(5000);
            continue;
          }
          break;
        }
      }
    }

    return {
      ok: false,
      provider: "",
      text: "",
      latencyMs: 0,
      status: 0,
      error: `semua provider free gagal -> ${errors.join(" | ")}`,
    };
}
