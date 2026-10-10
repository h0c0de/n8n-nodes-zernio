import type { ICredentialType, INodeProperties } from "n8n-workflow";

/**
 * API key opsional - hanya dibutuhkan oleh provider OpenRouter.
 * Provider OVHcloud dan LLM7.io berjalan anonim tanpa key.
 */
export class FreeAiApi implements ICredentialType {
  name = "freeAiApi";

  displayName = "Free AI API (OpenRouter, opsional)";

  documentationUrl = "https://openrouter.ai/docs";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: false,
      description:
        "Hanya untuk provider OpenRouter (openrouter/free). Kosongkan jika memakai OVHcloud atau LLM7.io yang anonim.",
    },
  ];

  // Tidak ada `authenticate`: header Authorization dibangun manual di node
  // (hanya provider OpenRouter yang butuh key, OVH/LLM7 anonim).
}
