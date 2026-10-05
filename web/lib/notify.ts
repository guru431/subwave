import { toast } from 'sonner';

// Thin wrapper around Sonner so every transient notification goes through one
// call site.
//
// `busy` stays up until the caller dismisses it by the returned id. `undo` is
// `ok` plus an Undo button and a longer dwell — prefer it over a confirm
// dialog, which taxes every correct action to guard the occasional misclick.
//
// NOT for persistent "controller is offline" / "data couldn't load" states
// (inline V3Alert cards, so they survive the auto-dismiss) or for field-level
// validation errors (inline next to the field).

export const notify = {
  ok: (message: string) => toast.success(message),
  err: (message: string) => toast.error(message, { duration: 6000 }),
  info: (message: string) => toast(message),
  // 10s: the operator has to read the message, decide it was wrong, and reach
  // the button.
  undo: (message: string, onUndo: () => void) =>
    toast.success(message, { duration: 10_000, action: { label: 'Undo', onClick: onUndo } }),
  // Тост о важном в чате. Отдельный метод, а не `info` с опциями: уведомление о
  // чате бесполезно, если из него нельзя попасть в чат, и форма у всех таких
  // тостов должна быть одна.
  chat: (title: string, body: string, onOpen: () => void) =>
    toast(title, {
      description: body,
      duration: 8000,
      action: { label: 'Открыть', onClick: onOpen },
    }),
  busy: (message: string): string | number =>
    toast.loading(message, { duration: Infinity }),
  dismiss: (id: string | number) => toast.dismiss(id),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
