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
    return { active: plan === "month" || plan === "year", plan: plan === "month" || plan === "year" ? plan : null };
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
