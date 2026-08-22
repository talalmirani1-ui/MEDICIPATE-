import { getStore } from '@netlify/blobs';

export const store = getStore({
  name: 'medicipate-payments',
  consistency: 'strong',
});

export async function readOrder(orderId) {
  const raw = await store.get(orderId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function writeOrder(orderId, order) {
  await store.set(orderId, JSON.stringify(order), {
    metadata: { updatedAt: new Date().toISOString() },
  });
}
