import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

export type Membership = { active: boolean; plan: "month" | "year" | null };

export const getMembership = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Membership> => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql<{ plan: string }>`
      select plan from subscriptions
      where user_id = ${context.userId}
        and status = 'active'
        and current_period_end > now()
      limit 1
    `;
    const plan = rows[0]?.plan;
    if (plan === "month" || plan === "year") return { active: true, plan };
    await reconcilePaidCheckout(sql, context.userId);
    const again = await sql<{ plan: string }>`
      select plan from subscriptions
      where user_id = ${context.userId}
        and status = 'active'
        and current_period_end > now()
      limit 1
    `;
    const next = again[0]?.plan;
    return { active: next === "month" || next === "year", plan: next === "month" || next === "year" ? next : null };
  });

export const startCheckout = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => {
    const data = input as { plan?: string; origin?: string };
    if (data?.plan !== "month" && data?.plan !== "year") throw new Error("Pick a plan.");
    let origin: URL;
    try {
      origin = new URL(String(data.origin ?? ""));
    } catch {
      throw new Error("Pick a plan.");
    }
    if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
      throw new Error("Pick a plan.");
    }
    return { plan: data.plan, origin: origin.origin };
  })
  .handler(async ({ data, context }) => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Card checkout is not connected on this server yet.");
    const amount = data.plan === "month" ? "999" : "10000";
    const interval = data.plan === "month" ? "month" : "year";
    const name = data.plan === "month" ? "Lineform Monthly" : "Lineform Annual";
    const body = new URLSearchParams({
      mode: "subscription",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": amount,
      "line_items[0][price_data][recurring][interval]": interval,
      "line_items[0][price_data][product_data][name]": name,
      success_url: `${data.origin}/?subscribed=1`,
      cancel_url: `${data.origin}/#plans`,
      client_reference_id: context.userId,
      "metadata[userId]": context.userId,
      "metadata[plan]": data.plan,
      "managed_payments[enabled]": "false",
      allow_promotion_codes: "true",
      payment_method_collection: "if_required",
    });
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = (await response.json()) as { url?: string; error?: { message?: string } };
    if (!response.ok || !payload.url) throw new Error(payload.error?.message || "Checkout could not start.");
    return { url: payload.url };
  });

async function reconcilePaidCheckout(
  sql: Awaited<ReturnType<typeof import("@/lib/db").getSql>>,
  userId: string,
) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return;
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions?limit=20", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) return;
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const session = payload.data?.find((item) => {
    const meta = item.metadata as { userId?: string; plan?: string } | undefined;
    const id = String(meta?.userId ?? item.client_reference_id ?? "");
    return item.status === "complete" && id === userId && (meta?.plan === "month" || meta?.plan === "year");
  });
  if (!session) return;
  const meta = session.metadata as { plan?: string };
  const plan = meta.plan === "year" ? "year" : "month";
  const customer = String(session.customer ?? "");
  const subscription = String(session.subscription ?? "");
  let periodEnd = new Date(Date.now() + (plan === "year" ? 366 : 32) * 86400000).toISOString();
  if (subscription) {
    const sub = await fetch(`https://api.stripe.com/v1/subscriptions/${subscription}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (sub.ok) {
      const body = (await sub.json()) as {
        current_period_end?: number;
        items?: { data?: Array<{ current_period_end?: number }> };
      };
      const end = body.current_period_end || body.items?.data?.[0]?.current_period_end;
      if (end) periodEnd = new Date(end * 1000).toISOString();
    }
  }
  await sql`
    insert into subscriptions (user_id, plan, status, stripe_customer, stripe_subscription, current_period_end)
    values (${userId}, ${plan}, 'active', ${customer}, ${subscription}, ${periodEnd})
    on conflict (user_id) do update set
      plan = excluded.plan,
      status = excluded.status,
      stripe_customer = excluded.stripe_customer,
      stripe_subscription = excluded.stripe_subscription,
      current_period_end = excluded.current_period_end,
      updated_at = now()
  `;
}
