/**
 * OpenAI 兼容适配器 — DeepSeek / OpenAI / Ollama 等 OpenAI 兼容端点的默认实现
 * 从 src/core/model-router.ts 原样迁移（行为不变）：client 缓存、thinking extra_body 透传、
 * reasoning_content 流式、usage 单次回调；新增错误分类 + retryable 网络层重试
 */

import OpenAI from "openai";
import type { ModelCompleteOptions, ModelResponse, StreamChunk, ToolCall } from "../../types.js";
import type { LlmAdapter, LlmConnection, LlmStreamOptions } from "./llm-adapter.js";
import { classifyError, errorMessage, isAbortError, isRetryable, toLlmError } from "./llm-error.js";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class OpenAICompatibleAdapterImpl implements LlmAdapter {
  readonly id = "openai-compatible";

  private clients = new Map<string, OpenAI>();

  private getClient(conn: LlmConnection): OpenAI {
    const key = `${conn.provider}:${conn.baseURL}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAI({ apiKey: conn.apiKey, baseURL: conn.baseURL });
      this.clients.set(key, client);
    }
    return client;
  }

  private toRequestParams(
    conn: LlmConnection,
    options: ModelCompleteOptions,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const requestParams: OpenAI.Chat.ChatCompletionCreateParams = {
      model: options.model || conn.model,
      messages: options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature: options.temperature ?? conn.temperature,
      max_tokens: options.maxTokens ?? conn.maxTokens,
    };
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools as unknown as OpenAI.Chat.ChatCompletionTool[];
    }
    return requestParams;
  }

  /** DeepSeek 思考模式需经 extra_body 传递（OpenAI SDK 兼容） */
  private requestOptions(conn: LlmConnection, signal?: AbortSignal): Record<string, unknown> {
    const extraBody: Record<string, unknown> = {};
    if (conn.thinking !== undefined) {
      extraBody.thinking = { type: conn.thinking ? "enabled" : "disabled" };
    }
    return {
      signal,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
    };
  }

  async complete(conn: LlmConnection, options: ModelCompleteOptions): Promise<ModelResponse> {
    const client = this.getClient(conn);
    const params = this.toRequestParams(conn, options);
    let attempt = 0;
    for (;;) {
      try {
        const response = (await client.chat.completions.create(
          params,
          this.requestOptions(conn, options.signal),
        )) as OpenAI.Chat.ChatCompletion;
        const choice = response.choices[0];
        const message = choice.message;

        const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        const usage = response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        return {
          text: message.content ?? "",
          toolCalls,
          hasToolCalls: toolCalls.length > 0,
          usage,
          finishReason: (choice.finish_reason as ModelResponse["finishReason"]) ?? "stop",
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        const code = classifyError(err);
        if (!isRetryable(code) || attempt >= MAX_RETRIES) {
          throw toLlmError(err, code);
        }
        attempt += 1;
        await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 8000));
      }
    }
  }

  async *completeStream(conn: LlmConnection, options: LlmStreamOptions): AsyncGenerator<StreamChunk> {
    const client = this.getClient(conn);
    let attempt = 0;
    // 本次生成器是否已产出过 chunk：一旦产出，迭代中途失败绝不重试
    // （消费者已收到部分输出，重试会导致文本/工具调用重复执行）
    let emitted = false;
    const emit = (chunk: StreamChunk): StreamChunk => {
      emitted = true;
      return chunk;
    };

    for (;;) {
      // 流创建阶段失败：未产出任何 chunk，可安全重试
      let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParams = {
          ...this.toRequestParams(conn, options),
          stream: true,
          stream_options: { include_usage: true },
        };
        stream = (await client.chat.completions.create(
          params,
          this.requestOptions(conn, options.signal),
        )) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
      } catch (err) {
        if (isAbortError(err)) {
          yield { type: "error", error: "aborted" };
          return;
        }
        const code = classifyError(err);
        if (isRetryable(code) && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 8000));
          continue;
        }
        yield { type: "error", error: errorMessage(err), errorCode: code };
        return;
      }

      const tcAcc: Map<number, { id: string; name: string; args: string }> = new Map();
      let finishReason: string = "stop";
      let streamPromptTokens = 0;
      let streamCompletionTokens = 0;

      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          const choiceFinish = chunk.choices?.[0]?.finish_reason;
          if (choiceFinish) {
            finishReason = choiceFinish;
          }

          // reasoning_content (DeepSeek R1 等推理模型)
          const reasoning = (delta as Record<string, unknown>)?.reasoning_content as string | undefined;
          if (reasoning) {
            yield emit({ type: "thinking", content: reasoning });
          }

          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index;
              if (!tcAcc.has(idx)) {
                tcAcc.set(idx, { id: tcDelta.id ?? "", name: "", args: "" });
              }
              const acc = tcAcc.get(idx)!;
              if (tcDelta.id) acc.id = tcDelta.id;
              if (tcDelta.function?.name) {
                acc.name = tcDelta.function.name;
                yield emit({ type: "tool_call_start", toolCallId: acc.id, toolName: acc.name });
              }
              if (tcDelta.function?.arguments) {
                acc.args += tcDelta.function.arguments;
                yield emit({ type: "tool_call_delta", toolCallId: acc.id, content: tcDelta.function.arguments });
              }
            }
          }

          if (delta?.content) {
            yield emit({ type: "text", content: delta.content });
          }

          // Capture usage from the last chunk (stream_options.include_usage ensures
          // it appears; only the last value is correct — accumulating per-chunk
          // would vastly overcount if the provider reports cumulative values).
          if (chunk.usage) {
            streamPromptTokens = chunk.usage.prompt_tokens;
            streamCompletionTokens = chunk.usage.completion_tokens;
          }
        }

        // Accumulate stream usage once (per-request, not per-chunk)
        options.onUsage?.({
          promptTokens: streamPromptTokens,
          completionTokens: streamCompletionTokens,
          totalTokens: streamPromptTokens + streamCompletionTokens,
        });

        const resolvedToolCalls: ToolCall[] = [];
        for (const [, acc] of tcAcc) {
          if (acc.id && acc.name) {
            resolvedToolCalls.push({
              id: acc.id,
              type: "function",
              function: { name: acc.name, arguments: acc.args },
            });
          }
        }

        yield {
          type: "done",
          finishReason: finishReason as StreamChunk["finishReason"],
          content: resolvedToolCalls.length > 0 ? JSON.stringify(resolvedToolCalls) : undefined,
        };
        return;
      } catch (err) {
        if (isAbortError(err)) {
          yield { type: "error", error: "aborted" };
          return;
        }
        const code = classifyError(err);
        // 迭代中途失败：若已产出过 chunk 则不再重试（防内容/工具调用重复）
        if (isRetryable(code) && !emitted && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 8000));
          continue;
        }
        yield { type: "error", error: errorMessage(err), errorCode: code };
        return;
      }
    }
  }
}

export const openaiCompatibleAdapter: LlmAdapter = new OpenAICompatibleAdapterImpl();
