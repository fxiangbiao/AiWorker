export const stream = $state({
  sending: false,
  abortController: null as AbortController | null,
});

export function setSending(s: boolean, ac?: AbortController | null) {
  stream.sending = s;
  stream.abortController = ac ?? null;
}
