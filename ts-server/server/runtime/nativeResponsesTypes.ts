export type NativeResponsesOutputItem =
  | { type: "message"; role: "assistant"; id?: string; status?: "completed" | "incomplete";
      phase?: "commentary" | "final_answer";
      content: Array<{ type: "output_text"; text: string; annotations: unknown[] } | { type: "refusal"; refusal: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string; status?: "completed" | "incomplete" }
  | { type: "reasoning"; id: string; summary: Array<{ type: "summary_text"; text: string }>; encrypted_content?: string };

/** Replayable output is isolated to the originating model, endpoint and credential. */
export interface NativeResponsesContext {
  scope: string;
  output: NativeResponsesOutputItem[];
}
