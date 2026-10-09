import { createHmac, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        const key = process.env.STRIPE_SECRET_KEY;
        if (!secret || !key) return new Response("Payments are not connected.", { status: 503 });
        const payload = await request.text();
        const header = request.headers.get("stripe-signature") ?? "";
        if (!signed(payload, header, secret)) return new Response("Bad signature.", { status: 400 });
        const event = JSON.parse(payload) as {
          type?: string;
          data?: { object?: Record<string, unknown> };
        };
        const object = event.data?.object ?? {};
        if (event.type === "checkout.session.completed") {
          const userId = String((object.metadata as { userId?: string } | undefined)?.userId ?? object.client_reference_id ?? "");
          const plan = String((object.metadata as { plan?: string } | undefined)?.plan ?? "");
          const subscription = String(object.subscription ?? "");
          const customer = String(object.customer ?? "");
          if (!userId || (plan !== "month" && plan !== "year")) return new Response("Ignored.", { status: 200 });
          let periodEnd = new Date(Date.now() + (plan === "year" ? 366 : 32) * 86400000).toISOString();
          if (subscription) {
            const sub = await fetch(`https://api.stripe.com/v1/subscriptions/${subscription}`, {
              headers: { Authorization: `Bearer ${key}` },
            });
            if (sub.ok) {
              const body = (await sub.json()) as { current_period_end?: number };
              if (body.current_period_end) periodEnd = new Date(body.current_period_end * 1000).toISOString();
            }
          }
          const { getSql } = await import("@/lib/db");
          const sql = await getSql();
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
        if (event.type === "customer.subscription.deleted") {
          const subscription = String(object.id ?? "");
          const { getSql } = await import("@/lib/db");
          const sql = await getSql();
          await sql`update subscriptions set status = 'canceled', updated_at = now() where stripe_subscription = ${subscription}`;
        }
        return new Response("ok");
      },
    },
  },
});

function signed(payload: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(",").map((part) => part.split("=")));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
  const actual = parts.v1 ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
