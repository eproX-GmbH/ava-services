// Nutzerbezogene AMQP-Queues wie in allen Producern (v0.1.53, vgl.
// company-contact/src/infrastructure/utils/per-user-routing.ts): Queue
// `<base>-<userId>`, Binding `<context>.<operation>.<userId>`, x-expires und
// x-message-ttl 6 h, damit verwaiste Queues und alte Nachrichten verschwinden.

export const EXCHANGE = "exchange";
export const BASE_QUEUE = "upsert-company-email";
/** Trigger des Contact Producers (packages/events: companyContact.createEmailVerification). */
export const TRIGGER = "companyContact.createEmailVerification";
export const PROGRESS = "transaction.progress";

export const PER_USER_QUEUE_ARGS = {
  "x-expires": 6 * 60 * 60 * 1000,
  "x-message-ttl": 6 * 60 * 60 * 1000,
} as const;

export function userScopedQueueName(base: string, userId: string): string {
  return userId ? `${base}-${userId}` : base;
}

export function userScopedBindingKey(base: string, userId: string): string {
  return userId ? `${base}.${userId}` : base;
}
